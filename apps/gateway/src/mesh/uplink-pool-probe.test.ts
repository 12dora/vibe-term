import { afterEach, describe, expect, test } from 'bun:test';
import type { PooledUplink } from './types';
import { UPLINK_POOL_FAIL_LOG_INTERVAL_MS } from './uplink-pool';
import {
  PROBE_LOG_INTERVAL_MS,
  type PreferredProbeHost,
  resetProbeLogThrottleForTests,
  runPreferredProbe,
} from './uplink-pool-probe';

const SH = 'https://sh.example';
const TK = 'https://tk.example';

afterEach(() => {
  resetProbeLogThrottleForTests();
});

function host(over: Partial<PreferredProbeHost> & { probeOk?: boolean } = {}): {
  logs: string[];
  nowMs: { current: number };
  switched: { value: boolean };
  run: () => Promise<void>;
} {
  const { probeOk, ...rest } = over;
  const logs: string[] = [];
  const nowMs = { current: 1_000 };
  const switched = { value: false };
  const attached = {
    publicUrl: TK,
    uplinkNodeId: null,
    mode: 'active' as const,
    writerEpoch: 1,
    since: 0,
  };
  const live = { state: 'online' } as PooledUplink;
  const h: PreferredProbeHost = {
    attachedUplink: () => attached,
    liveClient: () => live,
    candidates: () => [
      {
        publicUrl: SH,
        uplinkNodeId: null,
        mode: 'active',
        writerEpoch: 1,
        priority: 0,
        caFingerprint: null,
      },
      {
        publicUrl: TK,
        uplinkNodeId: null,
        mode: 'active',
        writerEpoch: 1,
        priority: 1,
        caFingerprint: null,
      },
    ],
    stopProbe: () => {},
    probeHealthz: async () => probeOk !== false,
    drainCount: () => 0,
    waitDrain: async () => {},
    switchTo: async () => {
      switched.value = true;
      return { ok: true };
    },
    log: (line) => logs.push(line),
    lastErrorOf: () => null,
    isLocalTransport: () => false,
    logSwitchBack: () => {},
    now: () => nowMs.current,
    probeLogAt: new Map<string, number>(),
    ...rest,
  };
  return { logs, nowMs, switched, run: () => runPreferredProbe(h) };
}

describe('runPreferredProbe logging', () => {
  test('PROBE_LOG_INTERVAL_MS 与池的 fail 日志间隔一致', () => {
    expect(PROBE_LOG_INTERVAL_MS).toBe(UPLINK_POOL_FAIL_LOG_INTERVAL_MS);
  });

  test('probe fail 按 hub 节流', async () => {
    const fx = host({ probeOk: false });
    await fx.run();
    await fx.run();
    expect(fx.logs.filter((row) => row.includes('probe fail')).length).toBe(1);
    fx.nowMs.current += PROBE_LOG_INTERVAL_MS;
    await fx.run();
    expect(fx.logs.filter((row) => row.includes('probe fail')).length).toBe(2);
  });

  test('probe ok 即将 switch 时不节流', async () => {
    const store = new Map<string, number>();
    const fx = host({ probeLogAt: store });
    await fx.run();
    await fx.run();
    expect(fx.logs.filter((row) => row.includes('probe ok')).length).toBe(2);
  });
});
