import { describe, expect, test } from 'bun:test';
import { RelayAutoSelect } from './relay-auto-select';
import type { SecondaryUplink } from './relay-secondary-attach';
import type { RelaySecrets } from './relay-secrets';
import type { RelaySwitchDeps, RelayUplinkView } from './relay-switch-route';
import type { MeshScheduler, PooledUplink, UplinkState } from './types';

const SH = 'https://sh.example';
const JP = 'https://jp.example';
const TK = 'https://tk.example';

class FakeScheduler implements MeshScheduler {
  nowMs = 1_000_000;
  readonly intervals: Array<{ fn: () => void; ms: number; clear: () => void }> = [];
  autoSleep = true;

  now(): number {
    return this.nowMs;
  }

  sleep(_ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.autoSleep) return Promise.resolve();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
        { once: true }
      );
    });
  }

  interval(fn: () => void, ms: number): { clear: () => void } {
    const rec = {
      fn,
      ms,
      clear: () => {
        const idx = this.intervals.indexOf(rec);
        if (idx >= 0) this.intervals.splice(idx, 1);
      },
    };
    this.intervals.push(rec);
    return rec;
  }
}

function secondary(url: string, rttMs: number, state: UplinkState = 'online'): SecondaryUplink {
  return {
    hubUrl: url,
    state,
    rttMs,
    quota: { maxNodes: 16, maxStreams: 64, bandwidthBytesPerSec: null },
    lastConnectError: null,
  } as SecondaryUplink;
}

async function setup(opts?: {
  probeHealthz?: (url: string) => Promise<boolean>;
  waitForDrain?: () => Promise<void>;
  preferredUrl?: string | null;
}) {
  const scheduler = new FakeScheduler();
  const switched: string[] = [];
  const preferred: string[] = [];
  const prepared: string[] = [];
  let current = SH;
  const live: PooledUplink = { state: 'online', hubUrl: SH } as PooledUplink;
  const secondaries = new Map<string, SecondaryUplink>([
    [JP, secondary(JP, 40)],
    [TK, secondary(TK, 80)],
  ]);
  const secrets = {
    setPreferredRelayUrl: (url: string) => preferred.push(url),
    clearPreferredRelayUrl: () => preferred.splice(0),
    preferredRelayUrl: () => opts?.preferredUrl ?? preferred.at(-1) ?? null,
    relayRows: () => [
      { url: SH, kicked: false },
      { url: JP, kicked: false },
      { url: TK, kicked: false },
    ],
  } as unknown as RelaySecrets;
  const uplink: RelayUplinkView = {
    liveClient: () => live,
    attachedHub: () => ({
      hubNodeId: null,
      publicUrl: current,
      mode: 'active',
      writerEpoch: 0,
      since: 1,
    }),
    reconfigure: async () => {},
    candidates: () => [],
    switchTo: async (url) => {
      switched.push(url);
      current = url;
      return { ok: true as const };
    },
    prepareSwitch: async (url) => {
      prepared.push(url);
    },
  };
  const auto = new RelayAutoSelect({
    scheduler,
    enabledSetting: true,
    intervalMs: 60_000,
    rows: () => secrets.relayRows(),
    preferredUrl: () => secrets.preferredRelayUrl(),
    currentUrl: () => current,
    liveClient: () => live,
    primaryClient: () =>
      ({ state: 'online', rttMs: 100, quota: { maxNodes: 16 }, lastConnectError: null }) as never,
    secondaryOf: (url) => secondaries.get(url) ?? null,
    presence: () => null,
    probeHealthz: opts?.probeHealthz ?? (async () => true),
    waitForDrain: opts?.waitForDrain ?? (async () => {}),
    switchDeps: (): RelaySwitchDeps => ({ secrets, uplink }),
  });
  auto.noteAttached(SH);
  auto.onRtt(SH, 100);
  auto.onRtt(SH, 100);
  auto.onRtt(JP, 40);
  auto.onRtt(JP, 40);
  auto.onRtt(TK, 80);
  auto.onRtt(TK, 80);
  auto.start();
  return { auto, scheduler, switched, preferred, prepared, live, secrets, uplink };
}

describe('RelayAutoSelect', () => {
  test('interval and rtt triggers evaluate; switchTo does not write preferred', async () => {
    const b = await setup();
    expect(b.scheduler.intervals).toHaveLength(1);
    expect(b.scheduler.intervals[0]?.ms).toBe(60_000);
    await b.auto.evaluate();
    expect(b.switched).toEqual([]);
    b.auto.onRtt(JP, 40);
    await b.auto.evaluate();
    expect(b.switched).toEqual([JP]);
    expect(b.preferred).toEqual([]);
    expect(b.prepared).toEqual([JP]);
    expect(b.auto.view()).toMatchObject({
      enabled: true,
      switchReason: 'auto-rtt',
    });
    expect(b.auto.view().lastSwitchAt).toBeGreaterThan(0);
  });

  test('drain wait runs before switch', async () => {
    let drained = false;
    let drainResolve: () => void = () => {};
    const drain = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
    const b = await setup({
      waitForDrain: async () => {
        drained = true;
        await drain;
      },
    });
    await b.auto.evaluate();
    expect(b.switched).toEqual([]);
    const pending = b.auto.evaluate();
    await Promise.resolve();
    expect(drained).toBe(true);
    expect(b.switched).toEqual([]);
    drainResolve();
    await pending;
    expect(b.switched).toEqual([JP]);
  });

  test('healthz gate blocks switchTo', async () => {
    const probed: string[] = [];
    const b = await setup({
      probeHealthz: async (url) => {
        probed.push(url);
        return false;
      },
    });
    await b.auto.evaluate();
    await b.auto.evaluate();
    expect(probed).toContain(JP);
    expect(b.switched).toEqual([]);
    expect(b.preferred).toEqual([]);
  });

  test('reason bookkeeping: startup then auto-rtt then manual note', async () => {
    const b = await setup();
    expect(b.auto.view().switchReason).toBe('startup');
    await b.auto.evaluate();
    await b.auto.evaluate();
    expect(b.auto.view().switchReason).toBe('auto-rtt');
    b.auto.noteSwitch('manual');
    b.auto.noteAttached(TK);
    expect(b.auto.view().switchReason).toBe('manual');
  });

  test('unsolicited attach after startup is auto-failover', async () => {
    const b = await setup();
    b.auto.noteAttached(TK);
    expect(b.auto.view().switchReason).toBe('auto-failover');
  });

  test('pin-failback when attaching to preferred', async () => {
    const b = await setup({ preferredUrl: JP });
    b.auto.noteAttached(JP);
    expect(b.auto.view().switchReason).toBe('pin-failback');
  });
});
