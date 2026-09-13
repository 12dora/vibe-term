import { describe, expect, test } from 'bun:test';
import {
  MeshProbeLoop,
  type ProbeLoopRow,
  type ProbeScheduler,
  failedAttemptedProbes,
  jitteredProbeIntervalMs,
  probeListKey,
} from './probe-loop';

type FakeRtc = { urls: string[] };

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function scheduler(): {
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  api: ProbeScheduler;
} {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    api: {
      interval(fn, ms) {
        const rec = { fn, ms, cleared: false };
        timers.push(rec);
        return {
          clear() {
            rec.cleared = true;
          },
        };
      },
    },
  };
}

function loopOf(
  rtc: FakeRtc,
  opts: ConstructorParameters<typeof MeshProbeLoop<FakeRtc, ProbeLoopRow>>[2],
  sched: ProbeScheduler,
  apply?: (records: Array<ProbeLoopRow & { probedAt: number }>) => void
): MeshProbeLoop<FakeRtc, ProbeLoopRow> {
  return new MeshProbeLoop(rtc, sched, opts, {
    intervalMs: 600_000,
    defaultMinIntervalMs: 30_000,
    urlsOf: (target) => target.urls,
    defaultProbeAll: async (urls) => urls.map((url) => ({ url, ok: true, rttMs: 1 })),
    applyResults: apply,
    logBatch: () => {},
  });
}

describe('probeListKey / jitter / failedAttemptedProbes', () => {
  test('probeListKey ignores order', () => {
    expect(probeListKey(['b', 'a'])).toBe(probeListKey(['a', 'b']));
    expect(probeListKey(['a'])).not.toBe(probeListKey(['a', 'b']));
  });

  test('jitter is ±10%', () => {
    expect(jitteredProbeIntervalMs(1_000, () => 0)).toBe(900);
    expect(jitteredProbeIntervalMs(1_000, () => 0.5)).toBe(1_000);
    expect(jitteredProbeIntervalMs(1_000, () => 1)).toBe(1_100);
  });

  test('failedAttemptedProbes ignores skipped and requires every attempt to fail', () => {
    expect(
      failedAttemptedProbes([{ ok: false, skipped: 'unsupported-scheme' }, { ok: true }])
    ).toBeNull();
    expect(failedAttemptedProbes([{ ok: false, skipped: 'unsupported-scheme' }])).toBeNull();
    const failed = failedAttemptedProbes([
      { ok: false, url: 'a' },
      { ok: false, skipped: 'unsupported-scheme', url: 'b' },
      { ok: false, url: 'c' },
    ]);
    expect(failed?.map((row) => row.url)).toEqual(['a', 'c']);
  });
});

describe('MeshProbeLoop', () => {
  test('start probes urlsOf, stamps probedAt, and arms a jittered tick', async () => {
    const calls: string[][] = [];
    const { timers, api } = scheduler();
    const loop = loopOf(
      { urls: ['stun:a:1'] },
      {
        now: () => 50_000,
        random: () => 0.5,
        minIntervalMs: 0,
        probeAll: async (urls) => {
          calls.push([...urls]);
          return urls.map((url) => ({ url, ok: true, rttMs: 7 }));
        },
      },
      api
    );
    loop.start();
    await flush();
    expect(calls).toEqual([['stun:a:1']]);
    expect(loop.lastResults).toEqual([{ url: 'stun:a:1', ok: true, rttMs: 7, probedAt: 50_000 }]);
    expect(timers[0]?.ms).toBe(600_000);
  });

  test('sync of a reordered list does not re-probe', async () => {
    const calls: string[][] = [];
    const rtc = { urls: ['stun:a:1', 'stun:b:1'] };
    const { api } = scheduler();
    const loop = loopOf(
      rtc,
      {
        now: () => 1,
        random: () => 0.5,
        minIntervalMs: 0,
        probeAll: async (urls) => {
          calls.push([...urls]);
          return urls.map((url) => ({ url, ok: true, rttMs: 1 }));
        },
      },
      api
    );
    loop.start();
    await flush();
    rtc.urls = ['stun:b:1', 'stun:a:1'];
    loop.sync(rtc);
    await flush();
    expect(calls).toHaveLength(1);
  });

  test('change-triggered cycles wait at least minIntervalMs', async () => {
    const clock = { now: 1_000 };
    const calls: string[][] = [];
    const rtc = { urls: ['stun:a:1'] };
    const { timers, api } = scheduler();
    const loop = loopOf(
      rtc,
      {
        now: () => clock.now,
        random: () => 0.5,
        minIntervalMs: 30_000,
        probeAll: async (urls) => {
          calls.push([...urls]);
          return urls.map((url) => ({ url, ok: true, rttMs: 1 }));
        },
      },
      api
    );
    loop.start();
    await flush();
    clock.now = 11_000;
    rtc.urls = ['stun:b:1'];
    loop.sync(rtc);
    await flush();
    expect(calls).toHaveLength(1);
    const wait = timers.find((row) => row.ms === 20_000);
    expect(wait).toBeTruthy();
    clock.now = 31_000;
    wait!.fn();
    await flush();
    expect(calls).toEqual([['stun:a:1'], ['stun:b:1']]);
  });

  test('probeAll throw becomes error rows and applyResults sees the cycle', async () => {
    const applied: string[][] = [];
    const { api } = scheduler();
    const loop = loopOf(
      { urls: ['stun:a:1', 'stun:b:1'] },
      {
        now: () => 9,
        random: () => 0.5,
        minIntervalMs: 0,
        probeAll: async () => {
          throw new Error('boom');
        },
      },
      api,
      (records) => applied.push(records.map((row) => row.url))
    );
    loop.start();
    await flush();
    expect(loop.lastResults).toEqual([
      { url: 'stun:a:1', ok: false, rttMs: 0, error: 'error', probedAt: 9 },
      { url: 'stun:b:1', ok: false, rttMs: 0, error: 'error', probedAt: 9 },
    ]);
    expect(applied).toEqual([['stun:a:1', 'stun:b:1']]);
  });

  test('logBatch throw is swallowed and lastResults still land', async () => {
    const { api } = scheduler();
    const loop = new MeshProbeLoop<FakeRtc, ProbeLoopRow>(
      { urls: ['stun:a:1'] },
      api,
      {
        now: () => 1,
        random: () => 0.5,
        minIntervalMs: 0,
        probeAll: async (urls) => urls.map((url) => ({ url, ok: true, rttMs: 1 })),
      },
      {
        intervalMs: 600_000,
        defaultMinIntervalMs: 30_000,
        urlsOf: (target) => target.urls,
        defaultProbeAll: async () => [],
        logBatch: () => {
          throw new Error('log fail');
        },
      }
    );
    loop.start();
    await flush();
    expect(loop.lastResults).toHaveLength(1);
  });

  test('test env without probeAll skips the network', async () => {
    let called = 0;
    const { api } = scheduler();
    const loop = new MeshProbeLoop<FakeRtc, ProbeLoopRow>(
      { urls: ['stun:a:1'] },
      api,
      { random: () => 0.5 },
      {
        intervalMs: 600_000,
        defaultMinIntervalMs: 30_000,
        urlsOf: (target) => target.urls,
        defaultProbeAll: async (urls) => {
          called += 1;
          return urls.map((url) => ({ url, ok: true, rttMs: 1 }));
        },
        logBatch: () => {},
      }
    );
    loop.start();
    await flush();
    expect(called).toBe(0);
    expect(loop.lastResults).toEqual([]);
  });

  test('stop clears timers and ignores later ticks', async () => {
    const { timers, api } = scheduler();
    const loop = loopOf(
      { urls: ['stun:a:1'] },
      {
        now: () => 1,
        random: () => 0.5,
        minIntervalMs: 0,
        probeAll: async (urls) => urls.map((url) => ({ url, ok: true, rttMs: 1 })),
      },
      api
    );
    loop.start();
    await flush();
    loop.stop();
    expect(timers[0]?.cleared).toBe(true);
    const before = loop.lastResults.length;
    timers[0]?.fn();
    await flush();
    expect(loop.lastResults).toHaveLength(before);
  });
});
