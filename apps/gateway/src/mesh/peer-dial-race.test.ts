import { describe, expect, test } from 'bun:test';
import {
  FOREGROUND_DC_BUDGET_MS,
  FOREGROUND_DIRECT_DEADLINE_MS,
  runDirectDialRace,
} from './peer-dial-race';

type FakeSession = { id: string; closed: string | null };

/** 可控时钟：`sleep` 挂在队列上，`advance` 推进 now 并结算到期的等待。 */
function fakeClock() {
  let now = 1_000;
  const waiters: Array<{ dueAt: number; resolve: () => void; reject: (err: unknown) => void }> = [];
  return {
    now: () => now,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(new Error('aborted'));
      return new Promise<void>((resolve, reject) => {
        const row = { dueAt: now + ms, resolve, reject };
        waiters.push(row);
        signal?.addEventListener(
          'abort',
          () => {
            const idx = waiters.indexOf(row);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const row of waiters.splice(0).sort((a, b) => a.dueAt - b.dueAt)) {
        if (row.dueAt <= now) row.resolve();
        else waiters.push(row);
      }
      await Bun.sleep(0);
      await Bun.sleep(0);
    },
    get pending() {
      return waiters.length;
    },
  };
}

describe('runDirectDialRace', () => {
  test('ws starts after the DC budget and wins while the stalled DC leg is cancelled', async () => {
    const clock = fakeClock();
    const dcLeg: { signal: AbortSignal | null } = { signal: null };
    let wsStartedAt = 0;
    const discarded: FakeSession[] = [];
    const race = runDirectDialRace<FakeSession>({
      dc: (signal) => {
        dcLeg.signal = signal;
        return new Promise<FakeSession | null>(() => {});
      },
      ws: async () => {
        wsStartedAt = clock.now();
        return { id: 'ws', closed: null };
      },
      wsFirst: false,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: new AbortController().signal,
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      discard: (_kind, session) => discarded.push(session),
    });
    await Bun.sleep(0);
    expect(wsStartedAt).toBe(0);
    await clock.advance(FOREGROUND_DC_BUDGET_MS);
    const outcome = await race;
    expect(outcome.winner).toBe('ws');
    expect(outcome.session?.id).toBe('ws');
    expect(outcome.pending).toBeNull();
    expect(wsStartedAt).toBe(1_000 + FOREGROUND_DC_BUDGET_MS);
    expect(dcLeg.signal?.aborted).toBe(true);
  });

  test('wsFirst starts both legs immediately', async () => {
    const clock = fakeClock();
    let wsStartedAt = 0;
    const outcome = await runDirectDialRace<FakeSession>({
      dc: () => new Promise<FakeSession | null>(() => {}),
      ws: async () => {
        wsStartedAt = clock.now();
        return { id: 'ws', closed: null };
      },
      wsFirst: true,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: new AbortController().signal,
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      discard: () => undefined,
    });
    expect(outcome.winner).toBe('ws');
    expect(wsStartedAt).toBe(1_000);
  });

  test('a DC leg that settles null starts ws without waiting out the budget', async () => {
    const clock = fakeClock();
    let wsStartedAt = 0;
    const outcome = await runDirectDialRace<FakeSession>({
      dc: async () => null,
      ws: async () => {
        wsStartedAt = clock.now();
        return { id: 'ws', closed: null };
      },
      wsFirst: false,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: new AbortController().signal,
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      discard: () => undefined,
    });
    expect(outcome.winner).toBe('ws');
    expect(wsStartedAt).toBe(1_000);
  });

  test('the deadline stops the wait but keeps the direct legs alive for the caller', async () => {
    const clock = fakeClock();
    const dcLeg: { signal: AbortSignal | null } = { signal: null };
    const dc: { finish: ((session: FakeSession) => void) | null } = { finish: null };
    const race = runDirectDialRace<FakeSession>({
      dc: (signal) => {
        dcLeg.signal = signal;
        return new Promise<FakeSession | null>((resolve) => {
          dc.finish = resolve;
        });
      },
      ws: async () => null,
      wsFirst: true,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: new AbortController().signal,
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      discard: () => undefined,
    });
    await clock.advance(FOREGROUND_DIRECT_DEADLINE_MS);
    const outcome = await race;
    expect(outcome.winner).toBeNull();
    expect(outcome.session).toBeNull();
    expect(outcome.pending).not.toBeNull();
    expect(dcLeg.signal?.aborted).toBe(false);
    dc.finish?.({ id: 'dc-late', closed: null });
    expect((await outcome.pending)?.id).toBe('dc-late');
  });

  test('a losing leg that resolves late is handed to discard, never to the caller', async () => {
    const clock = fakeClock();
    const dc: { finish: ((session: FakeSession) => void) | null } = { finish: null };
    const discarded: FakeSession[] = [];
    const outcome = await runDirectDialRace<FakeSession>({
      dc: () =>
        new Promise<FakeSession | null>((resolve) => {
          dc.finish = resolve;
        }),
      ws: async () => ({ id: 'ws', closed: null }),
      wsFirst: true,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: new AbortController().signal,
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      discard: (_kind, session) => discarded.push(session),
    });
    expect(outcome.winner).toBe('ws');
    dc.finish?.({ id: 'dc-late', closed: null });
    await Bun.sleep(0);
    expect(discarded.map((row) => row.id)).toEqual(['dc-late']);
  });

  test('a zero-delay scheduler does not let the deadline pre-empt the legs', async () => {
    const outcome = await runDirectDialRace<FakeSession>({
      dc: async () => null,
      ws: async () => ({ id: 'ws', closed: null }),
      wsFirst: false,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: new AbortController().signal,
      now: () => 1_000,
      sleep: async () => undefined,
      discard: () => undefined,
    });
    expect(outcome.winner).toBe('ws');
  });

  test('an aborted parent signal aborts every leg', async () => {
    const clock = fakeClock();
    const abort = new AbortController();
    const dcLeg: { signal: AbortSignal | null } = { signal: null };
    const race = runDirectDialRace<FakeSession>({
      dc: (signal) => {
        dcLeg.signal = signal;
        return new Promise<FakeSession | null>((resolve) => {
          signal.addEventListener('abort', () => resolve(null), { once: true });
        });
      },
      ws: (signal) =>
        new Promise<FakeSession | null>((resolve) => {
          signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
      wsFirst: true,
      budgetMs: FOREGROUND_DC_BUDGET_MS,
      deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
      signal: abort.signal,
      now: () => clock.now(),
      sleep: (ms, signal) => clock.sleep(ms, signal),
      discard: () => undefined,
    });
    abort.abort(new Error('stopped'));
    const outcome = await race;
    expect(outcome.winner).toBeNull();
    expect(dcLeg.signal?.aborted).toBe(true);
  });
});
