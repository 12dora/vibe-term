import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { setLang, t } from '../i18n';
import { parseArgs } from '../lib/args';
import type { FetchLike } from '../lib/fetch-like';
import {
  INTERRUPT_EXIT_CODE,
  RELAY_JOIN_POLL_INTERVAL_MS,
  RELAY_JOIN_WAIT_TIMEOUT_MS,
  type RelayAdmissionWatch,
  RelayJoinWaitError,
  settleRelayAdmission,
  sigintAbortSignal,
  waitForRelayAdmission,
} from './relay-join-wait';
import { RelayApiError } from './relay-shared';

const TENANT = 'ab'.repeat(16);

function emptyKeyLog(): Response {
  return Response.json({ key_log: [], has_more: false });
}

function watchWith(fetcher: FetchLike): RelayAdmissionWatch {
  return {
    entry: { url: 'https://relay.example', tenantId: TENANT, token: new Uint8Array(32) },
    headers: { 'x-test-token': 'token' },
    fetcher,
    logKey: new Uint8Array(32),
    rootPublicKey: new Uint8Array(32),
    nodeIdHex: 'cd'.repeat(16),
    records: [],
  };
}

function fakeClock(onSleep?: (sleeps: number) => void) {
  let current = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
      sleeps.push(ms);
      onSleep?.(sleeps.length);
    },
  };
}

afterEach(() => setLang('en'));

const NEXT_AUTO = t('relay.join.next.auto');
const NEXT_RESTART = t('relay.join.next.restart');

const QUIET = new AbortController().signal;

function waitIo(clock: ReturnType<typeof fakeClock>, joinWaitTimeoutMs = 3_000) {
  return {
    now: clock.now,
    sleep: clock.sleep,
    joinPollIntervalMs: 1_000,
    joinWaitTimeoutMs,
    interruptSignal: QUIET,
  };
}

describe('waitForRelayAdmission', () => {
  test('polls the key log with the tenant token until the deadline, then reports a timeout', async () => {
    const urls: string[] = [];
    const headers: unknown[] = [];
    const fetcher: FetchLike = async (input, init) => {
      urls.push(String(input));
      headers.push(init?.headers);
      return emptyKeyLog();
    };
    const clock = fakeClock();
    const error = await waitForRelayAdmission(
      watchWith(fetcher),
      waitIo(clock, 3_500),
      'restarted'
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(RelayJoinWaitError);
    expect(error.code).toBe('approval_timeout');
    expect(error.message).toBe(t('relay.join.timeout', { minutes: 1, next: NEXT_AUTO }));
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toBe(
      `https://relay.example/api/relay/tenants/${TENANT}/keylog?from_seq=1&limit=64`
    );
    expect(headers.every((value) => (value as Record<string, string>)['x-test-token'])).toBe(true);
  });

  test('without a restarted service the timeout says to restart instead of promising auto-join', async () => {
    const clock = fakeClock();
    const error = await waitForRelayAdmission(
      watchWith(async () => emptyKeyLog()),
      waitIo(clock, 1_000),
      'manual'
    ).catch((caught) => caught);
    expect(error.message).toBe(t('relay.join.timeout', { minutes: 1, next: NEXT_RESTART }));
    expect(error.message).not.toContain('automatically');
  });

  test('defaults to a 3 second interval and a 10 minute window', () => {
    expect(RELAY_JOIN_POLL_INTERVAL_MS).toBe(3_000);
    expect(RELAY_JOIN_WAIT_TIMEOUT_MS).toBe(600_000);
    expect(INTERRUPT_EXIT_CODE).toBe(130);
  });

  test('keeps waiting through connection failures and a body cut mid-read', async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Unable to connect');
      if (calls === 2) {
        const cut = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('socket closed'));
          },
        });
        return new Response(cut, { status: 200 });
      }
      return emptyKeyLog();
    };
    const clock = fakeClock();
    await expect(
      waitForRelayAdmission(watchWith(fetcher), waitIo(clock), 'restarted')
    ).rejects.toMatchObject({ code: 'approval_timeout' });
    expect(calls).toBe(4);
  });

  test.each([408, 429, 500, 502, 503, 504])(
    'keeps waiting through a proxy-level HTTP %d',
    async (status) => {
      let calls = 0;
      const fetcher: FetchLike = async () => {
        calls += 1;
        if (calls === 1) return Response.json({ error: { code: 'BOOM' } }, { status });
        return emptyKeyLog();
      };
      const clock = fakeClock();
      await expect(
        waitForRelayAdmission(watchWith(fetcher), waitIo(clock), 'restarted')
      ).rejects.toMatchObject({ code: 'approval_timeout' });
      expect(calls).toBe(4);
    }
  );

  test.each([
    [401, 'RELAY_TOKEN_INVALID'],
    [403, 'HTTP_403'],
    [404, 'RELAY_TENANT_NOT_FOUND'],
  ])('HTTP %d ends the wait immediately', async (status, code) => {
    const fetcher: FetchLike = async () => Response.json({ error: { code } }, { status });
    const clock = fakeClock();
    const error = await waitForRelayAdmission(watchWith(fetcher), waitIo(clock), 'restarted').catch(
      (caught) => caught
    );
    expect(error).toBeInstanceOf(RelayApiError);
    expect(error.code).toBe(code);
    expect(clock.sleeps).toEqual([]);
  });

  test('a page that cannot be opened is a verification failure, not network trouble', async () => {
    const fetcher: FetchLike = async () =>
      Response.json({ key_log: [{ seq: 1, blob: { v: 1 } }], has_more: false });
    const clock = fakeClock();
    const error = await waitForRelayAdmission(watchWith(fetcher), waitIo(clock), 'restarted').catch(
      (caught) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RelayJoinWaitError);
    expect(clock.sleeps).toEqual([]);
  });

  test('Ctrl+C while sleeping stops the wait with the interrupted message', async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    const error = await waitForRelayAdmission(
      watchWith(async () => emptyKeyLog()),
      {
        now: clock.now,
        sleep: (_ms, signal) =>
          new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
            controller.abort();
          }),
        interruptSignal: controller.signal,
      },
      'restarted'
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(RelayJoinWaitError);
    expect(error.code).toBe('interrupted');
    expect(error.message).toBe(t('relay.join.interrupted', { next: NEXT_AUTO }));
  });

  test('Ctrl+C during a request aborts that request instead of waiting for the relay', async () => {
    const controller = new AbortController();
    let requestAborted = false;
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => {
          requestAborted = true;
          reject(new Error('aborted'));
        });
        queueMicrotask(() => controller.abort());
      });
    await expect(
      waitForRelayAdmission(
        watchWith(hanging),
        { interruptSignal: controller.signal, relayTimeoutMs: 60_000 },
        'restarted'
      )
    ).rejects.toMatchObject({ code: 'interrupted' });
    expect(requestAborted).toBe(true);
  });

  test('an already interrupted signal never touches the relay', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetched = false;
    const fetcher: FetchLike = async () => {
      fetched = true;
      return emptyKeyLog();
    };
    await expect(
      waitForRelayAdmission(watchWith(fetcher), { interruptSignal: controller.signal }, 'restarted')
    ).rejects.toMatchObject({ code: 'interrupted' });
    expect(fetched).toBe(false);
  });
});

describe('sigintAbortSignal', () => {
  test('aborts on SIGINT and keeps its listener so a second SIGINT cannot kill the process', () => {
    const emitter = new EventEmitter();
    const signal = sigintAbortSignal(emitter);
    expect(signal.aborted).toBe(false);
    emitter.emit('SIGINT');
    expect(signal.aborted).toBe(true);
    expect(emitter.listenerCount('SIGINT')).toBe(1);
    emitter.emit('SIGINT');
    expect(emitter.listenerCount('SIGINT')).toBe(1);
  });
});

describe('settleRelayAdmission', () => {
  const join = parseArgs(['relay', 'join']);

  test('does nothing for a node that is already admitted', async () => {
    const logs: string[] = [];
    await settleRelayAdmission(join, null, { log: (line) => logs.push(line) }, 'restarted');
    expect(logs).toEqual([]);
  });

  test('--no-wait only tells where the approval happens and never polls', async () => {
    let fetched = false;
    const logs: string[] = [];
    await settleRelayAdmission(
      parseArgs(['relay', 'join', '--no-wait']),
      watchWith(async () => {
        fetched = true;
        return emptyKeyLog();
      }),
      { log: (line) => logs.push(line) },
      'restarted'
    );
    expect(fetched).toBe(false);
    expect(logs).toEqual([t('relay.join.pendingLater')]);
  });

  test('--no-wait without a restarted service says to restart, once', async () => {
    const logs: string[] = [];
    await settleRelayAdmission(
      parseArgs(['relay', 'join', '--no-wait']),
      watchWith(async () => emptyKeyLog()),
      { log: (line) => logs.push(line) },
      'manual'
    );
    expect(logs).toEqual([t('relay.join.pendingLaterRestart')]);
  });

  test('--no-wait still works when the flag is followed by a positional', async () => {
    const parsed = parseArgs(['relay', 'join', '--no-wait', 'https://relay.example']);
    const logs: string[] = [];
    await settleRelayAdmission(
      parsed,
      watchWith(async () => {
        throw new Error('must not poll');
      }),
      { log: (line) => logs.push(line) },
      'restarted'
    );
    expect(logs).toEqual([t('relay.join.pendingLater')]);
  });

  test('Ctrl+C prints the interrupted note and exits 130 without throwing', async () => {
    const controller = new AbortController();
    const codes: number[] = [];
    const logs: string[] = [];
    await settleRelayAdmission(
      join,
      watchWith(async () => emptyKeyLog()),
      {
        log: (line) => logs.push(line),
        setExitCode: (code) => codes.push(code),
        interruptSignal: controller.signal,
        sleep: async () => controller.abort(),
        joinPollIntervalMs: 1,
      },
      'manual'
    );
    expect(logs).toEqual([t('relay.join.interrupted', { next: NEXT_RESTART })]);
    expect(codes).toEqual([130]);
  });

  test('a timeout is still an error and does not touch the exit code', async () => {
    const clock = fakeClock();
    const codes: number[] = [];
    await expect(
      settleRelayAdmission(
        join,
        watchWith(async () => emptyKeyLog()),
        { ...waitIo(clock, 1_000), setExitCode: (code) => codes.push(code) },
        'restarted'
      )
    ).rejects.toMatchObject({ code: 'approval_timeout' });
    expect(codes).toEqual([]);
  });
});
