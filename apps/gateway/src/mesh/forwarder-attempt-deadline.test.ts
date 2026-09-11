import { afterEach, describe, expect, test } from 'bun:test';
import {
  ForwardDeadlineError,
  UPLOAD_BUDGET_CAP_MS,
  UPLOAD_MIN_THROUGHPUT_BPS,
  UploadStallError,
  armAttemptDeadline,
  armDeferredTimeout,
  authorizedAttemptBudgetsMs,
  httpHeadTimeoutMs,
  httpStreamTransferBudgetMs,
  requestBodyUploadBudgetMs,
  runLinkThenTransfer,
  setHttpHeadDeadlineMs,
  setUploadStallMs,
  uploadBudgetMs,
  waitLinkOrAbort,
  withHttpStreamUploadDeadline,
  wrapUploadDestination,
} from './forwarder-attempt-deadline';

afterEach(() => {
  setHttpHeadDeadlineMs(0);
  setUploadStallMs(0);
});

describe('armAttemptDeadline', () => {
  test('aborts at the budget and dispose clears the timer', async () => {
    const parent = new AbortController();
    const armed = armAttemptDeadline(parent.signal, 30);
    expect(armed.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(armed.signal.aborted).toBe(true);
    expect(armed.signal.reason).toBeInstanceOf(ForwardDeadlineError);
    armed.dispose();
  });

  test('chains the caller abort', () => {
    const parent = new AbortController();
    const armed = armAttemptDeadline(parent.signal, 60_000);
    parent.abort(new Error('caller'));
    expect(armed.signal.aborted).toBe(true);
    armed.dispose();
  });
});

describe('waitLinkOrAbort', () => {
  test('resolves when getLink wins', async () => {
    const parent = new AbortController();
    const link = { id: 'ok' };
    await expect(waitLinkOrAbort(Promise.resolve(link), parent.signal)).resolves.toBe(link);
  });

  test('throws when abort wins against a hanging getLink', async () => {
    const parent = new AbortController();
    const hanging = new Promise<{ id: string }>(() => {});
    const pending = waitLinkOrAbort(hanging, parent.signal);
    parent.abort();
    await expect(pending).rejects.toBeInstanceOf(ForwardDeadlineError);
  });
});

describe('uploadBudgetMs', () => {
  test('30 MB at 128 KiB/s floor covers a 500 KiB/s far-node upload', () => {
    const bodyBytes = 30 * 1024 * 1024;
    const extraMs = uploadBudgetMs(bodyBytes);
    const uploadAt500KiB = Math.ceil((bodyBytes / (500 * 1024)) * 1000);
    expect(extraMs).toBe(Math.ceil((bodyBytes / UPLOAD_MIN_THROUGHPUT_BPS) * 1000));
    expect(extraMs).toBe(240_000);
    expect(extraMs).toBeGreaterThan(uploadAt500KiB);
    expect(uploadAt500KiB).toBeGreaterThan(20_000);
    expect(extraMs).toBeLessThanOrEqual(UPLOAD_BUDGET_CAP_MS);
  });

  test('empty or invalid sizes add no extra budget', () => {
    expect(uploadBudgetMs(0)).toBe(0);
    expect(uploadBudgetMs(-1)).toBe(0);
    expect(uploadBudgetMs(Number.NaN)).toBe(0);
  });

  test('huge bodies are capped at 10 min', () => {
    expect(uploadBudgetMs(UPLOAD_MIN_THROUGHPUT_BPS * 60 * 20)).toBe(UPLOAD_BUDGET_CAP_MS);
  });
});

describe('requestBodyUploadBudgetMs', () => {
  test('known content-length uses the size-aware budget', () => {
    expect(requestBodyUploadBudgetMs({ contentLength: 30 * 1024 * 1024, hasRawBody: true })).toBe(
      240_000
    );
  });

  test('raw body without length gets the cap; JSON-only does not', () => {
    expect(requestBodyUploadBudgetMs({ hasRawBody: true })).toBe(UPLOAD_BUDGET_CAP_MS);
    expect(requestBodyUploadBudgetMs({ hasRawBody: false })).toBe(0);
    expect(requestBodyUploadBudgetMs({ contentLength: 0, hasRawBody: false })).toBe(0);
  });
});

describe('httpStreamTransferBudgetMs', () => {
  test('GET-like (no body) is just the short floor', () => {
    expect(httpStreamTransferBudgetMs({ floorMs: 5_000, hasBody: false })).toBe(5_000);
  });

  test('content-length / 128 KiB/s sits on top of the floor, capped at 10 min', () => {
    expect(
      httpStreamTransferBudgetMs({
        floorMs: 5_000,
        headers: { 'content-length': String(30 * 1024 * 1024) },
        hasBody: true,
      })
    ).toBe(5_000 + 240_000);
    expect(
      httpStreamTransferBudgetMs({
        floorMs: 5_000,
        hasBody: true,
      })
    ).toBe(5_000 + UPLOAD_BUDGET_CAP_MS);
  });
});

describe('withHttpStreamUploadDeadline', () => {
  test('aborts a hanging open at floor + upload budget; caller abort still wins', async () => {
    const hanging = (signal: AbortSignal) =>
      new Promise<string>((_, reject) => {
        const fail = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    const started = Date.now();
    await expect(
      withHttpStreamUploadDeadline(
        new AbortController().signal,
        40,
        { 'content-length': '1' },
        true,
        hanging
      )
    ).rejects.toBeInstanceOf(ForwardDeadlineError);
    expect(Date.now() - started).toBeLessThan(1_000);

    const parent = new AbortController();
    const pending = withHttpStreamUploadDeadline(
      parent.signal,
      60_000,
      { 'content-length': String(30 * 1024 * 1024) },
      true,
      hanging
    );
    parent.abort(new Error('caller'));
    await expect(pending).rejects.toThrow('caller');
  });
});

describe('wrapUploadDestination', () => {
  test('stalled write rejects at the stall timeout', async () => {
    setUploadStallMs(30);
    const wrapped = wrapUploadDestination(
      {
        write: () => new Promise(() => {}),
        end: async () => {},
      },
      {}
    );
    const started = Date.now();
    await expect(wrapped.write(new Uint8Array([1]))).rejects.toBeInstanceOf(UploadStallError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('caller abort wins over a hung write', async () => {
    setUploadStallMs(200);
    const abort = new AbortController();
    const wrapped = wrapUploadDestination(
      {
        write: () => new Promise(() => {}),
        end: async () => {},
      },
      { abort: abort.signal }
    );
    const pending = wrapped.write(new Uint8Array([1]));
    abort.abort(new Error('caller'));
    await expect(pending).rejects.toThrow('caller');
  });

  test('already-aborted wrap does not leak a rejected write', async () => {
    const abort = new AbortController();
    abort.abort(new Error('caller'));
    let rejectWrite: (err: unknown) => void = () => {};
    const wrapped = wrapUploadDestination(
      {
        write: () =>
          new Promise<void>((_, reject) => {
            rejectWrite = reject;
          }),
        end: async () => {},
      },
      { abort: abort.signal }
    );
    const pending = wrapped.write(new Uint8Array([1]));
    await expect(pending).rejects.toThrow('caller');
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      leaked.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      rejectWrite(new Error('stream is closed'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(leaked).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('slow write that still completes within the stall window succeeds', async () => {
    setUploadStallMs(80);
    const wrapped = wrapUploadDestination(
      {
        write: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        end: async () => {},
      },
      {}
    );
    await wrapped.write(new Uint8Array([1]));
    await wrapped.end();
  });
});

describe('authorizedAttemptBudgetsMs', () => {
  test('GET-like requests keep the short link and overall budgets', () => {
    const budgets = authorizedAttemptBudgetsMs({
      linkMs: 5_000,
      overallMs: 10_000,
      hasRawBody: false,
    });
    expect(budgets).toEqual({ linkMs: 5_000, transferMs: 5_000, overallMs: 10_000 });
  });

  test('30 MB push extends transfer and overall, not the getLink budget', () => {
    const budgets = authorizedAttemptBudgetsMs({
      linkMs: 5_000,
      overallMs: 10_000,
      headers: { 'content-length': String(30 * 1024 * 1024) },
      hasRawBody: true,
    });
    expect(budgets.linkMs).toBe(5_000);
    expect(budgets.transferMs).toBe(5_000 + 240_000);
    expect(budgets.overallMs).toBe(10_000 + 240_000);
  });
});

describe('httpHeadTimeoutMs', () => {
  test('test override shortens the body-less head deadline', () => {
    setHttpHeadDeadlineMs(80);
    expect(httpHeadTimeoutMs()).toBe(80);
    setHttpHeadDeadlineMs(0);
    expect(httpHeadTimeoutMs(1)).toBeGreaterThanOrEqual(5_000);
    expect(httpHeadTimeoutMs(1)).toBeLessThanOrEqual(20_000);
  });
});

describe('armDeferredTimeout', () => {
  test('without armAfter fires at timeoutMs', async () => {
    let fired = 0;
    const armed = armDeferredTimeout({
      timeoutMs: 30,
      onTimeout: () => {
        fired += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fired).toBe(1);
    armed.dispose();
  });

  test('does not start until armAfter resolves', async () => {
    let fired = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const armed = armDeferredTimeout({
      timeoutMs: 20,
      armAfter: gate,
      onTimeout: () => {
        fired += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fired).toBe(1);
    armed.dispose();
  });

  test('abort during armAfter prevents onTimeout', async () => {
    let fired = 0;
    const abort = new AbortController();
    const armed = armDeferredTimeout({
      timeoutMs: 20,
      armAfter: new Promise(() => {}),
      abort: abort.signal,
      onTimeout: () => {
        fired += 1;
      },
    });
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(0);
    armed.dispose();
  });
});

describe('runLinkThenTransfer', () => {
  test('hanging getLink fails at the short link budget', async () => {
    const parent = new AbortController();
    const started = Date.now();
    await expect(
      runLinkThenTransfer({
        parent: parent.signal,
        linkBudgetMs: 40,
        transferBudgetMs: 60_000,
        getLink: new Promise<{ id: string }>(() => {}),
        transfer: async () => 'nope',
      })
    ).rejects.toBeInstanceOf(ForwardDeadlineError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('parent abort during a long transfer still wins', async () => {
    const parent = new AbortController();
    const link = { id: 'ok' };
    const pending = runLinkThenTransfer({
      parent: parent.signal,
      linkBudgetMs: 5_000,
      transferBudgetMs: 60_000,
      getLink: Promise.resolve(link),
      transfer: (_link, signal) =>
        new Promise<string>((_, reject) => {
          const fail = () => reject(signal.reason ?? new Error('aborted'));
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        }),
    });
    parent.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
