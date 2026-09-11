import { afterEach, describe, expect, test } from 'bun:test';
import {
  ForwardDeadlineError,
  UPLOAD_BUDGET_CAP_MS,
  UPLOAD_MIN_THROUGHPUT_BPS,
  armAttemptDeadline,
  armDeferredTimeout,
  authorizedAttemptBudgetsMs,
  httpHeadTimeoutMs,
  requestBodyUploadBudgetMs,
  runLinkThenTransfer,
  setHttpHeadDeadlineMs,
  uploadBudgetMs,
  waitLinkOrAbort,
} from './forwarder-attempt-deadline';

afterEach(() => {
  setHttpHeadDeadlineMs(0);
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
