import { describe, expect, test } from 'bun:test';
import type { LinkStream } from '@vibeterm/shared/link';
import type { RelayQuota } from '@vibeterm/shared/relay';
import type { UserStore } from '../auth/user-store';
import {
  type RelayRtcHolder,
  createRelayMultiAttach,
  markCachedNodesOffline,
  minQuotaFileBytes,
  primaryNodeListApplyPatch,
} from './relay-multi-attach';
import { RelayPresence } from './relay-presence';
import type { SecondaryUplink } from './relay-secondary-attach';
import type { RelayWiring } from './relay-wiring';
import { waitUntil } from './test-support';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import type { UplinkClientOptions } from './uplink-client';
import type { UplinkPool } from './uplink-pool';
import type { UplinkNodeList } from './uplink-protocol';

function quota(over: Partial<RelayQuota> = {}): RelayQuota {
  return {
    maxNodes: 8,
    maxStreams: 16,
    bandwidthBytesPerSec: null,
    ...over,
  };
}

describe('minQuotaFileBytes', () => {
  test('primary 在线时取所有已连接中继的最小 maxFileBytes', () => {
    expect(
      minQuotaFileBytes(quota({ maxFileBytes: 100 }), [
        { quota: quota({ maxFileBytes: 40 }) },
        { quota: quota({ maxFileBytes: 80 }) },
      ])?.maxFileBytes
    ).toBe(40);
  });

  test('primary 掉线时仍返回 secondary 的有限上限', () => {
    expect(
      minQuotaFileBytes(null, [{ quota: quota({ maxFileBytes: 50 * 1024 * 1024 }) }])?.maxFileBytes
    ).toBe(50 * 1024 * 1024);
  });

  test('没有任何有限上限时 primary 为 null 则返回 null', () => {
    expect(minQuotaFileBytes(null, [{ quota: quota() }])).toBeNull();
    expect(minQuotaFileBytes(null, [])).toBeNull();
  });
});

const SH = 'https://sh.example';
const TK = 'https://tk.example';
const PEER_A = 'aa'.repeat(16);
const PEER_B = 'bb'.repeat(16);

function listed(id: string, online: boolean): UplinkNodeList['nodes'][number] {
  return {
    id,
    name: id.slice(0, 4),
    online,
    endpoints: [],
    inventory: {},
    direct_capable: false,
    version: '2.2.4',
  };
}

function nodeList(nodes: UplinkNodeList['nodes'], version = 1): UplinkNodeList {
  return {
    t: 'node.list',
    version,
    key_log_head: { seq: 0n, hash: new Uint8Array(32) },
    rtc: { stun: [], turn: null },
    nodes,
  };
}

class FireScheduler implements MeshScheduler {
  nowMs = 1_000;
  readonly intervals: Array<{ fn: () => void; clear: () => void }> = [];

  now(): number {
    return this.nowMs;
  }

  sleep(_ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
        { once: true }
      );
    });
  }

  interval(fn: () => void, _ms: number): { clear: () => void } {
    const rec = {
      fn,
      clear: () => {
        const idx = this.intervals.indexOf(rec);
        if (idx >= 0) this.intervals.splice(idx, 1);
      },
    };
    this.intervals.push(rec);
    return rec;
  }

  fireIntervals(): void {
    for (const rec of [...this.intervals]) rec.fn();
  }
}

class FakeSecondary implements SecondaryUplink {
  state: UplinkState = 'offline';
  rttMs: number | null = 12;
  quota = null;
  rtc = { stun: [] as string[], turn: null };
  nodesViaRelay = 0;
  awaitingToken = false;
  lastConnectError: { reason: string; at: number } | null = null;
  readonly onNodeList?: (list: UplinkNodeList) => void;
  private readonly listeners: Array<(state: UplinkState) => void> = [];
  private closed: { resolve: () => void } | null = null;
  private closedPromise: Promise<void> | null = null;

  constructor(opts: UplinkClientOptions) {
    this.hubUrl = opts.hubUrl;
    this.onNodeList = opts.onNodeList;
  }

  readonly hubUrl: string;
  start(): void {}
  async stop(): Promise<void> {
    this.setState('offline');
    this.releaseClosed();
  }
  async attemptConnect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('aborted');
    this.setState('online');
  }
  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'online') return Promise.resolve();
    this.closedPromise ??= new Promise((resolve) => {
      this.closed = { resolve };
    });
    signal?.addEventListener('abort', () => this.releaseClosed(), { once: true });
    return this.closedPromise;
  }
  setOnRelayStream(_handler: InboundRelayHandler | null): void {}
  sendStatus(): void {}
  sendCtl(): void {}
  async openRelay(_to: string): Promise<LinkStream> {
    return { id: this.hubUrl } as unknown as LinkStream;
  }
  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
  disconnect(): void {
    this.setState('offline');
    this.releaseClosed();
  }
  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.listeners) cb(state);
  }
  private releaseClosed(): void {
    this.closed?.resolve();
    this.closed = null;
    this.closedPromise = null;
  }
}

function stubUplink(
  url: string,
  live: { state: UplinkState; rttMs?: number | null } | null = null
): UplinkPool {
  return {
    attachedHub: () => ({ publicUrl: url, nodeId: PEER_A, name: 'sh' }),
    liveClient: () => live,
    onAttached: () => () => {},
    onDetached: () => () => {},
    openRelay: async () => {
      throw new Error('no-primary-relay');
    },
    identity: { nodeId: 'cc'.repeat(16), edSecretKey: new Uint8Array(64) },
  } as unknown as UplinkPool;
}

function stubWiring(): RelayWiring {
  return {
    secrets: {
      uplinkKind: () => 'relay',
      relayRows: () => [
        { url: SH, priority: 0 },
        { url: TK, priority: 1 },
      ],
      credentialKeyFor: () => '',
    },
  } as unknown as RelayWiring;
}

function baseClient(scheduler: MeshScheduler): Omit<UplinkClientOptions, 'hubUrl' | 'onNodeList'> {
  return {
    identity: { nodeId: 'cc'.repeat(16), edSecretKey: new Uint8Array(64) },
    userId: 'user-1',
    keyLogApplier: {
      async head() {
        return { seq: 0n, hash: new Uint8Array(32) };
      },
      async applyMany() {
        return { applied: 0 };
      },
    } as KeyLogApplier,
    userStore: {} as UserStore,
    statusProvider: (): UplinkStatus => ({
      version: '1',
      tmux: false,
      direct_capable: false,
      inventory: {},
      endpoints: [],
    }),
    scheduler,
  };
}

describe('relay multi-attach presence overlay', () => {
  test('markCachedNodesOffline 只把指定节点打成 offline', () => {
    const rtc: RelayRtcHolder = {
      lastRtc: null,
      lastNodeList: nodeList([listed(PEER_A, true), listed(PEER_B, true)]),
    };
    markCachedNodesOffline(rtc, [PEER_B]);
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_A)?.online).toBe(true);
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_B)?.online).toBe(false);
  });

  test('secondary-only peer 掉线并过 hold 后离线一次，primary 清单节点不受影响', async () => {
    const scheduler = new FireScheduler();
    const rtc: RelayRtcHolder = { lastRtc: null, lastNodeList: nodeList([listed(PEER_A, true)]) };
    const offline: string[][] = [];
    const spawned: FakeSecondary[] = [];
    const attach = createRelayMultiAttach({
      wiring: stubWiring(),
      uplink: stubUplink(SH),
      spawn: (opts) => {
        const client = new FakeSecondary(opts);
        spawned.push(client);
        return client;
      },
      baseClient: baseClient(scheduler),
      scheduler,
      onRelayStream: () => {},
      onExclusiveOffline: (ids) => {
        offline.push([...ids]);
      },
      rtc,
    });
    attach.start();
    attach.handlePrimaryState('online', SH, 20);
    attach.applyPrimaryList(nodeList([listed(PEER_A, true)]));
    expect(attach.presence.peersOnlineOn(SH)).toBe(1);
    await attach.reconcile();
    await waitUntil(() => spawned.some((client) => client.state === 'online'));
    const secondary = spawned.find((client) => client.hubUrl === TK);
    expect(secondary).toBeDefined();
    secondary?.onNodeList?.(nodeList([listed(PEER_B, true)], 2));
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_A)?.online).toBe(true);
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_B)?.online).toBe(true);

    secondary?.disconnect();
    await waitUntil(() => scheduler.intervals.length > 0);
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_B)?.online).toBe(true);
    expect(offline).toEqual([]);

    scheduler.nowMs += 90_000;
    scheduler.fireIntervals();
    expect(offline).toEqual([[PEER_B]]);
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_A)?.online).toBe(true);
    expect(rtc.lastNodeList?.nodes.find((node) => node.id === PEER_B)?.online).toBe(false);

    const incoming = nodeList([listed(PEER_A, true)], 3);
    const patch = primaryNodeListApplyPatch(attach, rtc.lastNodeList?.nodes ?? [], incoming);
    const extras = patch.extraListedNodes();
    expect(extras.find((node) => node.id === PEER_B)?.online).toBe(false);
    expect([...patch.onlineUnionIds()]).not.toContain(PEER_B);
    expect([...patch.onlineUnionIds()]).toContain(PEER_A);

    scheduler.fireIntervals();
    expect(offline).toEqual([[PEER_B]]);
    await attach.stop();
  });

  test('extraListedNodes 不会用陈旧 lastNodes 把已 decay 的节点复活为 online', () => {
    const presence = new RelayPresence();
    presence.setPrimary(SH);
    presence.setConnected(SH, true, 10, 1_000);
    presence.applyList(SH, [{ id: PEER_A, online: true }], 1, 1_000);
    presence.setConnected(TK, false, null, 1_000);
    presence.applyList(TK, [{ id: PEER_B, online: false }], 1, 1_000);
    const attach = {
      presence,
      applyPrimaryList() {},
    } as unknown as ReturnType<typeof createRelayMultiAttach>;
    const lastNodes = [listed(PEER_A, true), listed(PEER_B, true)];
    const incoming = nodeList([listed(PEER_A, true)]);
    const extras = primaryNodeListApplyPatch(attach, lastNodes, incoming).extraListedNodes();
    expect(extras).toEqual([listed(PEER_B, false)]);
  });

  test('applyPrimaryList 后不 setConnected 也给出 per-URL 在线计数', async () => {
    const scheduler = new FireScheduler();
    const attach = createRelayMultiAttach({
      wiring: stubWiring(),
      uplink: stubUplink(SH),
      spawn: (opts) => new FakeSecondary(opts),
      baseClient: baseClient(scheduler),
      scheduler,
      onRelayStream: () => {},
      onExclusiveOffline: () => {},
      rtc: { lastRtc: null, lastNodeList: null },
    });
    attach.start();
    attach.applyPrimaryList(nodeList([listed(PEER_A, true)]));
    expect(attach.presence.peersOnlineOn(SH)).toBe(1);
    expect(attach.presence.snapshot().find((row) => row.url === SH)?.connected).toBe(false);
    await attach.stop();
  });

  test('live client 在线时 applyPrimaryList 补 connected；瞬态非 online 不 markDisconnected', async () => {
    const scheduler = new FireScheduler();
    const live = { state: 'online' as UplinkState, rttMs: 20 };
    const attach = createRelayMultiAttach({
      wiring: stubWiring(),
      uplink: stubUplink(SH, live),
      spawn: (opts) => new FakeSecondary(opts),
      baseClient: baseClient(scheduler),
      scheduler,
      onRelayStream: () => {},
      onExclusiveOffline: () => {},
      rtc: { lastRtc: null, lastNodeList: null },
    });
    attach.start();
    attach.applyPrimaryList(nodeList([listed(PEER_A, true), listed(PEER_B, true)]));
    expect(attach.presence.peersOnlineOn(SH)).toBe(2);
    expect(attach.presence.snapshot().find((row) => row.url === SH)?.connected).toBe(true);

    attach.handlePrimaryState('connecting', SH, null);
    expect(attach.presence.snapshot().find((row) => row.url === SH)?.connected).toBe(true);
    expect(attach.presence.peersOnlineOn(SH)).toBe(2);

    live.state = 'offline';
    attach.handlePrimaryState('offline', SH, null);
    expect(attach.presence.snapshot().find((row) => row.url === SH)?.connected).toBe(false);
    expect(attach.presence.peersOnlineOn(SH)).toBe(2);
    await attach.stop();
  });
});
