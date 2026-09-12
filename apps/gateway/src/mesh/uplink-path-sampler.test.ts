import { afterEach, describe, expect, test } from 'bun:test';
import type { TcpProbeResult } from './port-reach-probe';
import type { MeshScheduler } from './types';
import {
  UPLINK_DEGRADE_MIN_INTERVAL_MS,
  UPLINK_DEGRADE_MIN_LINK_AGE_MS,
} from './uplink-degrade-policy';
import {
  UPLINK_PATH_RERACE_REASON,
  UPLINK_PATH_SAMPLE_CONNECTS,
  UPLINK_PATH_SAMPLE_INTERVAL_MS,
  type UplinkPathProbeFn,
  UplinkPathSampler,
  considerUplinkPathRerace,
  isUplinkPathRerace,
  resetUplinkPathSamplerForTest,
  sleepAfterUplinkSession,
  startUplinkPathSampling,
  stopUplinkPathSampling,
  uplinkPathHostKey,
  uplinkPathView,
  uplinkTcpTarget,
} from './uplink-path-sampler';

class ManualScheduler implements MeshScheduler {
  nowMs = 1_000;
  sleeps: number[] = [];
  readonly intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  private sleepers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      const entry = { resolve, reject };
      this.sleepers.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((row) => row !== entry);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true }
      );
    });
  }

  interval(fn: () => void, ms: number): { clear: () => void } {
    const handle = { fn, ms, cleared: false };
    this.intervals.push(handle);
    return {
      clear() {
        handle.cleared = true;
      },
    };
  }

  flushSleeps(): void {
    const queued = this.sleepers.splice(0);
    for (const row of queued) row.resolve();
  }
}

function pendingProbe() {
  const pending: Array<{
    host: string;
    port: number;
    resolve: (result: TcpProbeResult) => void;
  }> = [];
  const probe: UplinkPathProbeFn = (host, port) =>
    new Promise((resolve) => {
      pending.push({ host, port, resolve });
    });
  return { probe, pending };
}

afterEach(() => {
  resetUplinkPathSamplerForTest();
  delete process.env.VIBETERM_UPLINK_PATH_SAMPLING;
});

describe('uplinkTcpTarget / host key', () => {
  test('公网 https 默认 443，ws 默认 80，跳过回环和 RFC1918', () => {
    expect(uplinkTcpTarget('https://relay.example/path')).toEqual({
      host: 'relay.example',
      port: 443,
    });
    expect(uplinkTcpTarget('wss://hub.example:8443/hub/uplink')).toEqual({
      host: 'hub.example',
      port: 8443,
    });
    expect(uplinkTcpTarget('ws://hub.example/hub/uplink')).toEqual({
      host: 'hub.example',
      port: 80,
    });
    expect(uplinkTcpTarget('https://127.0.0.1')).toBeNull();
    expect(uplinkTcpTarget('https://10.0.0.8')).toBeNull();
    expect(uplinkTcpTarget('https://192.168.1.1')).toBeNull();
    expect(uplinkTcpTarget('https://localhost')).toBeNull();
    expect(uplinkPathHostKey('https://Relay.Example:443/x')).toBe('relay.example');
  });
});

describe('UplinkPathSampler TCP sampling', () => {
  test('每个公网目标并行 3 次 TCP connect，只记录成功的 connectMs', async () => {
    const scheduler = new ManualScheduler();
    const fake = pendingProbe();
    const sampler = new UplinkPathSampler({
      scheduler,
      targets: () => ['https://relay.example', 'https://10.0.0.1', 'https://relay.example/dup'],
      probe: fake.probe,
    });
    const sampling = sampler.sampleAll();
    expect(fake.pending).toHaveLength(UPLINK_PATH_SAMPLE_CONNECTS);
    expect(new Set(fake.pending.map((row) => `${row.host}:${row.port}`))).toEqual(
      new Set(['relay.example:443'])
    );
    fake.pending[0]?.resolve({ verdict: 'ok', connectMs: 42 });
    fake.pending[1]?.resolve({ verdict: 'timeout', connectMs: null });
    fake.pending[2]?.resolve({ verdict: 'ok', connectMs: 31 });
    await sampling;
    expect(sampler.bestMs('https://relay.example')).toBe(31);
    expect(sampler.memory.samplesOf('relay.example')).toHaveLength(2);
    for (const sample of sampler.memory.samplesOf('relay.example')) {
      expect(sample.kind).toBe('tcp-connect');
    }
  });

  test('start 立刻采样并按 5 min 间隔再跑', async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const sampler = new UplinkPathSampler({
      scheduler,
      targets: () => ['https://hub.example'],
      probe: async () => {
        calls += 1;
        return { verdict: 'ok', connectMs: 12 };
      },
    });
    sampler.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(UPLINK_PATH_SAMPLE_CONNECTS);
    expect(scheduler.intervals[0]?.ms).toBe(UPLINK_PATH_SAMPLE_INTERVAL_MS);
    scheduler.intervals[0]?.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(UPLINK_PATH_SAMPLE_CONNECTS * 2);
    sampler.stop();
    expect(scheduler.intervals[0]?.cleared).toBe(true);
  });
});

describe('heartbeat + degrade re-race', () => {
  test('连续 3 次慢心跳且空闲时触发，并打 re-race / re-race_result 日志', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 1_000_000;
    const lines: string[] = [];
    const sampler = new UplinkPathSampler({
      scheduler,
      targets: () => [],
      log: (line) => lines.push(line),
    });
    sampler.memory.record('relay.example', { kind: 'tcp-connect', rttMs: 80, at: scheduler.nowMs });
    const beat = (rttMs: number, extra: Partial<Parameters<typeof sampler.onHeartbeat>[0]> = {}) =>
      sampler.onHeartbeat({
        url: 'https://relay.example',
        rttMs,
        linkAgeMs: UPLINK_DEGRADE_MIN_LINK_AGE_MS,
        inFlightStreams: 0,
        now: scheduler.nowMs,
        ...extra,
      });

    expect(beat(200)).toBe(false);
    expect(beat(210)).toBe(false);
    expect(beat(220)).toBe(true);
    expect(lines).toEqual([
      '[uplink] path re-race url=relay.example cur_ms=220 best_ms=80 try=1/3',
    ]);
    expect(sampler.reraceCount('https://relay.example')).toBe(1);

    scheduler.nowMs += 1_000;
    expect(beat(90)).toBe(false);
    scheduler.nowMs += 1_000;
    expect(beat(70)).toBe(false);
    scheduler.nowMs += 1_000;
    expect(beat(60)).toBe(false);
    expect(lines[1]).toBe(
      '[uplink] path re-race_result url=relay.example old_ms=220 new_ms=60 better=true'
    );
  });

  test('有在途流时等待，空闲后下一次心跳才重赛', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 5_000_000;
    const sampler = new UplinkPathSampler({ scheduler, targets: () => [], log: () => {} });
    sampler.memory.record('hub.example', { kind: 'tcp-connect', rttMs: 50, at: scheduler.nowMs });
    const beat = (inFlightStreams: number) =>
      sampler.onHeartbeat({
        url: 'https://hub.example',
        rttMs: 200,
        linkAgeMs: UPLINK_DEGRADE_MIN_LINK_AGE_MS,
        inFlightStreams,
        now: scheduler.nowMs,
      });
    expect(beat(1)).toBe(false);
    expect(beat(2)).toBe(false);
    expect(beat(3)).toBe(false);
    expect(beat(0)).toBe(true);
  });

  test('好的心跳自己拉低参考，之后同样 RTT 不再触发', () => {
    const scheduler = new ManualScheduler();
    const sampler = new UplinkPathSampler({ scheduler, targets: () => [] });
    sampler.memory.record('relay.example', { kind: 'tcp-connect', rttMs: 200, at: 0 });
    const beat = (rttMs: number) =>
      sampler.onHeartbeat({
        url: 'https://relay.example',
        rttMs,
        linkAgeMs: UPLINK_DEGRADE_MIN_LINK_AGE_MS,
        inFlightStreams: 0,
        now: scheduler.now(),
      });
    expect(beat(40)).toBe(false);
    expect(sampler.bestMs('relay.example')).toBe(40);
    expect(beat(40)).toBe(false);
    expect(beat(40)).toBe(false);
  });
});

describe('module wiring / env', () => {
  test('VIBETERM_UPLINK_PATH_SAMPLING=off 不启动', () => {
    process.env.VIBETERM_UPLINK_PATH_SAMPLING = 'off';
    const scheduler = new ManualScheduler();
    expect(
      startUplinkPathSampling({
        scheduler,
        targets: () => ['https://relay.example'],
      })
    ).toBeNull();
    expect(
      considerUplinkPathRerace({
        url: 'https://relay.example',
        rttMs: 500,
        linkAgeMs: UPLINK_DEGRADE_MIN_LINK_AGE_MS,
        inFlightStreams: 0,
        now: 1,
      })
    ).toBe(false);
  });

  test('start 后 heartbeat 写入参考并出现在 pathView', async () => {
    const scheduler = new ManualScheduler();
    startUplinkPathSampling({
      scheduler,
      targets: () => [],
      probe: async () => ({ verdict: 'ok', connectMs: 18 }),
    });
    expect(
      considerUplinkPathRerace({
        url: 'https://relay.example',
        rttMs: 22,
        linkAgeMs: 1_000,
        inFlightStreams: 0,
        now: scheduler.now(),
      })
    ).toBe(false);
    expect(uplinkPathView('https://relay.example')).toEqual({ pathBestMs: 22 });
    stopUplinkPathSampling();
    expect(uplinkPathView('https://relay.example')).toEqual({});
  });
});

describe('sleepAfterUplinkSession', () => {
  test('path-rerace 立即返回，不进退避', async () => {
    const scheduler = new ManualScheduler();
    const ac = new AbortController();
    expect(await sleepAfterUplinkSession(scheduler, ac.signal, UPLINK_PATH_RERACE_REASON)).toBe(
      'ok'
    );
    expect(scheduler.sleeps).toEqual([]);
    expect(isUplinkPathRerace('path-rerace')).toBe(true);
    expect(isUplinkPathRerace('missed-pong')).toBe(false);
  });

  test('其它原因走最小退避', async () => {
    const scheduler = new ManualScheduler();
    const ac = new AbortController();
    const pending = sleepAfterUplinkSession(scheduler, ac.signal, 'missed-pong');
    expect(scheduler.sleeps.length).toBe(1);
    expect(scheduler.sleeps[0]).toBeGreaterThan(0);
    scheduler.flushSleeps();
    expect(await pending).toBe('ok');
  });
});

describe('re-race budget', () => {
  test('同一主机一小时内最多 3 次，两次间隔至少 2 分钟', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 8_000_000;
    const sampler = new UplinkPathSampler({ scheduler, targets: () => [], log: () => {} });
    sampler.memory.record('r.example', { kind: 'tcp-connect', rttMs: 40, at: scheduler.nowMs });
    const fire = () => {
      const slow = { rttMs: 200, linkAgeMs: UPLINK_DEGRADE_MIN_LINK_AGE_MS, inFlightStreams: 0 };
      sampler.onHeartbeat({ url: 'https://r.example', now: scheduler.nowMs, ...slow });
      sampler.onHeartbeat({ url: 'https://r.example', now: scheduler.nowMs, ...slow });
      return sampler.onHeartbeat({ url: 'https://r.example', now: scheduler.nowMs, ...slow });
    };
    expect(fire()).toBe(true);
    scheduler.nowMs += UPLINK_DEGRADE_MIN_INTERVAL_MS;
    expect(fire()).toBe(true);
    scheduler.nowMs += UPLINK_DEGRADE_MIN_INTERVAL_MS;
    expect(fire()).toBe(true);
    scheduler.nowMs += UPLINK_DEGRADE_MIN_INTERVAL_MS;
    expect(fire()).toBe(false);
    expect(sampler.reraceCount('https://r.example')).toBe(3);
  });
});
