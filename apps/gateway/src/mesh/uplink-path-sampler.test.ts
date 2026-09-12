import { afterEach, describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import type { TcpProbeResult } from './port-reach-probe';
import { TCP_CANARY_PORT, resetTcpSamplingTrustForTest } from './tcp-sampling-trust';

const TRUSTED = async () => true;
const settleMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
import type { MeshScheduler } from './types';
import {
  UPLINK_DEGRADE_MIN_INTERVAL_MS,
  UPLINK_DEGRADE_MIN_LINK_AGE_MS,
} from './uplink-degrade-policy';
import {
  UPLINK_PATH_RERACE_REASON,
  UPLINK_PATH_SAMPLE_CONNECTS,
  UPLINK_PATH_SAMPLE_INTERVAL_MS,
  type UplinkHeartbeatSample,
  type UplinkPathProbeFn,
  UplinkPathSampler,
  UplinkStreamGate,
  collectUplinkPathTargets,
  considerUplinkPathRerace,
  createUplinkPathHeartbeat,
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

function hb(
  over: Partial<UplinkHeartbeatSample> & Pick<UplinkHeartbeatSample, 'url' | 'rttMs' | 'now'>
): UplinkHeartbeatSample {
  return {
    linkAgeMs: UPLINK_DEGRADE_MIN_LINK_AGE_MS,
    inFlightStreams: 0,
    clientId: 'c1',
    generation: 1,
    ...over,
  };
}

function stubStream() {
  let close!: () => void;
  return {
    closed: new Promise<void>((resolve) => {
      close = resolve;
    }),
    reset() {
      close();
    },
  };
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
      trust: TRUSTED,
      scheduler,
      targets: () => ['https://relay.example', 'https://10.0.0.1', 'https://relay.example/dup'],
      probe: fake.probe,
    });
    const sampling = sampler.sampleAll();
    await settleMicrotasks();
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
      trust: TRUSTED,
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
      trust: TRUSTED,
      scheduler,
      targets: () => [],
      log: (line) => lines.push(line),
    });
    sampler.memory.record('relay.example', { kind: 'tcp-connect', rttMs: 80, at: scheduler.nowMs });
    const beat = (rttMs: number, extra: Partial<UplinkHeartbeatSample> = {}) =>
      sampler.onHeartbeat(
        hb({ url: 'https://relay.example', rttMs, now: scheduler.nowMs, ...extra })
      );

    expect(beat(200)).toBe(false);
    expect(beat(210)).toBe(false);
    expect(beat(220)).toBe(true);
    expect(lines).toEqual([
      '[uplink] path re-race url=relay.example cur_ms=220 best_ms=80 try=1/3',
    ]);
    expect(sampler.reraceCount('https://relay.example')).toBe(1);

    scheduler.nowMs += 1_000;
    expect(beat(90, { generation: 2 })).toBe(false);
    scheduler.nowMs += 1_000;
    expect(beat(70, { generation: 2 })).toBe(false);
    scheduler.nowMs += 1_000;
    expect(beat(60, { generation: 2 })).toBe(false);
    expect(lines[1]).toBe(
      '[uplink] path re-race_result url=relay.example old_ms=220 new_ms=60 better=true'
    );
  });

  test('有在途流时等待，空闲后下一次心跳才重赛', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 5_000_000;
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => [],
      log: () => {},
    });
    sampler.memory.record('hub.example', { kind: 'tcp-connect', rttMs: 50, at: scheduler.nowMs });
    const beat = (inFlightStreams: number) =>
      sampler.onHeartbeat(
        hb({ url: 'https://hub.example', rttMs: 200, now: scheduler.nowMs, inFlightStreams })
      );
    expect(beat(1)).toBe(false);
    expect(beat(2)).toBe(false);
    expect(beat(3)).toBe(false);
    expect(beat(0)).toBe(true);
  });

  test('好的心跳自己拉低参考，之后同样 RTT 不再触发', () => {
    const scheduler = new ManualScheduler();
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => [],
    });
    sampler.memory.record('relay.example', { kind: 'tcp-connect', rttMs: 200, at: 0 });
    const beat = (rttMs: number) =>
      sampler.onHeartbeat(hb({ url: 'https://relay.example', rttMs, now: scheduler.now() }));
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
    expect(considerUplinkPathRerace(hb({ url: 'https://relay.example', rttMs: 500, now: 1 }))).toBe(
      false
    );
  });

  test('start 后 heartbeat 写入参考并出现在 pathView', async () => {
    const scheduler = new ManualScheduler();
    startUplinkPathSampling({
      scheduler,
      targets: () => [],
      probe: async () => ({ verdict: 'ok', connectMs: 18 }),
    });
    expect(
      considerUplinkPathRerace(
        hb({ url: 'https://relay.example', rttMs: 22, now: scheduler.now(), linkAgeMs: 1_000 })
      )
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
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => [],
      log: () => {},
    });
    sampler.memory.record('r.example', { kind: 'tcp-connect', rttMs: 40, at: scheduler.nowMs });
    const fire = () => {
      const slow = hb({ url: 'https://r.example', rttMs: 200, now: scheduler.nowMs });
      sampler.onHeartbeat(slow);
      sampler.onHeartbeat(slow);
      return sampler.onHeartbeat(slow);
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

describe('relay + hub sampling targets', () => {
  test('两个中继行、无 hub 时每个公网 host 每拍 3 次 connect，行变更下一拍才生效', async () => {
    const scheduler = new ManualScheduler();
    const fake = pendingProbe();
    const rows: Array<{ url: string }> = [
      { url: 'https://relay-a.example' },
      { url: 'https://relay-b.example' },
    ];
    const hub = { candidates: () => [] as Array<{ publicUrl: string }> };
    const relay = { secrets: { relayRows: () => rows } };
    expect(collectUplinkPathTargets(hub.candidates(), relay.secrets.relayRows())).toEqual([
      'https://relay-a.example',
      'https://relay-b.example',
    ]);
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => collectUplinkPathTargets(hub.candidates(), relay.secrets.relayRows()),
      probe: fake.probe,
    });
    const takeTick = async (expectedHosts: string[]) => {
      const seen = new Map<string, number>();
      const sampling = sampler.sampleAll();
      const deadline = Date.now() + 1_000;
      while (
        expectedHosts.some((host) => (seen.get(host) ?? 0) < UPLINK_PATH_SAMPLE_CONNECTS) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const batch = fake.pending.splice(0);
        for (const row of batch) {
          seen.set(row.host, (seen.get(row.host) ?? 0) + 1);
          row.resolve({ verdict: 'ok', connectMs: 20 });
        }
      }
      await sampling;
      for (const host of expectedHosts) expect(seen.get(host)).toBe(UPLINK_PATH_SAMPLE_CONNECTS);
    };
    await takeTick(['relay-a.example', 'relay-b.example']);
    rows.splice(0, rows.length, { url: 'https://relay-c.example' });
    await takeTick(['relay-c.example']);
  });
});

describe('pending open 计入 in-flight', () => {
  test('openStream 未完成时重赛判定 busy', async () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 5_000_000;
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => [],
      log: () => {},
    });
    sampler.memory.record('hub.example', { kind: 'tcp-connect', rttMs: 50, at: scheduler.nowMs });
    const gate = new UplinkStreamGate<ReturnType<typeof stubStream>>();
    let release!: (stream: ReturnType<typeof stubStream>) => void;
    const opening = gate.open(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    expect(gate.count()).toBe(1);
    const beat = () =>
      sampler.onHeartbeat(
        hb({
          url: 'https://hub.example',
          rttMs: 200,
          now: scheduler.nowMs,
          inFlightStreams: gate.count(),
        })
      );
    expect(beat()).toBe(false);
    expect(beat()).toBe(false);
    expect(beat()).toBe(false);
    const stream = stubStream();
    release(stream);
    await opening;
    expect(gate.count()).toBe(1);
    stream.reset();
    await stream.closed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gate.count()).toBe(0);
    expect(beat()).toBe(true);
  });
});

describe('re-race_result 按连接结算', () => {
  test('同 host 另一条连接的心跳不结算，只有被重赛客户端的新代心跳才打 result', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 3_000_000;
    const lines: string[] = [];
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => [],
      log: (line) => lines.push(line),
    });
    sampler.memory.record('relay.example', { kind: 'tcp-connect', rttMs: 80, at: scheduler.nowMs });
    const beat = (clientId: string, generation: number, rttMs = 200) =>
      sampler.onHeartbeat(
        hb({ url: 'https://relay.example', rttMs, now: scheduler.nowMs, clientId, generation })
      );
    expect(beat('primary', 1)).toBe(false);
    expect(beat('primary', 1)).toBe(false);
    expect(beat('primary', 1)).toBe(true);
    expect(lines).toHaveLength(1);

    expect(beat('secondary', 1)).toBe(false);
    expect(beat('secondary', 2)).toBe(false);
    expect(beat('secondary', 3)).toBe(false);
    expect(lines).toHaveLength(1);

    expect(beat('primary', 1, 50)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(beat('primary', 2, 90)).toBe(false);
    expect(beat('primary', 2, 70)).toBe(false);
    expect(beat('primary', 2, 60)).toBe(false);
    expect(lines[1]).toBe(
      '[uplink] path re-race_result url=relay.example old_ms=200 new_ms=60 better=true'
    );
  });

  test('重赛后的连接不满 3 拍就断线，普通重连的新代心跳不会补足旧重赛的 result', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 3_000_000;
    const lines: string[] = [];
    const sampler = new UplinkPathSampler({
      trust: TRUSTED,
      scheduler,
      targets: () => [],
      log: (line) => lines.push(line),
    });
    sampler.memory.record('relay.example', { kind: 'tcp-connect', rttMs: 80, at: scheduler.nowMs });
    const beat = (generation: number, rttMs = 200) =>
      sampler.onHeartbeat(
        hb({ url: 'https://relay.example', rttMs, now: scheduler.nowMs, clientId: 'p', generation })
      );
    beat(1);
    beat(1);
    expect(beat(1)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(beat(2, 90)).toBe(false);
    expect(beat(2, 90)).toBe(false);
    expect(beat(3, 60)).toBe(false);
    expect(beat(3, 60)).toBe(false);
    expect(beat(3, 60)).toBe(false);
    expect(lines).toHaveLength(1);
  });
});

describe('createUplinkPathHeartbeat in-flight', () => {
  test('pending open / key-log 计入 inFlight 时判定 busy，空闲后才 tearDown', () => {
    const scheduler = new ManualScheduler();
    scheduler.nowMs = 4_000_000;
    let inFlight = 1;
    const torn: string[] = [];
    startUplinkPathSampling({ scheduler, targets: () => [], log: () => {} })?.memory.record(
      'relay.example',
      { kind: 'tcp-connect', rttMs: 40, at: scheduler.nowMs }
    );
    const hb = createUplinkPathHeartbeat({
      scheduler,
      intervalMs: 15_000,
      sendPing: () => {},
      tearDown: (reason) => torn.push(reason),
      url: () => 'https://relay.example',
      linkAgeMs: () => UPLINK_DEGRADE_MIN_LINK_AGE_MS,
      inFlight: () => inFlight,
      generation: () => 4,
    });
    hb.start({} as LinkSession, () => true);
    const ping = () => {
      const handle = scheduler.intervals[scheduler.intervals.length - 1];
      handle?.fn();
      scheduler.nowMs += 200;
      hb.onPong();
    };
    ping();
    ping();
    ping();
    expect(torn).toEqual([]);
    inFlight = 0;
    ping();
    expect(torn).toEqual([UPLINK_PATH_RERACE_REASON]);
  });
});

describe('UplinkPathSampler canary', () => {
  test('a stack that completes the canary handshake disables TCP sampling and logs once', async () => {
    resetTcpSamplingTrustForTest();
    const scheduler = new ManualScheduler();
    const lines: string[] = [];
    const ports: number[] = [];
    const sampler = new UplinkPathSampler({
      scheduler,
      targets: () => ['https://hub.example'],
      probe: async (_host, port) => {
        ports.push(port);
        return { verdict: 'ok', connectMs: 9 };
      },
      log: (line) => lines.push(line),
    });
    try {
      await sampler.sampleAll();
      await sampler.sampleAll();
      expect(ports).toEqual([TCP_CANARY_PORT]);
      expect(sampler.memory.bestMs('hub.example')).toBeNull();
      expect(lines.filter((line) => line.includes('tcp path sampling disabled'))).toHaveLength(1);
    } finally {
      resetTcpSamplingTrustForTest();
    }
  });
});
