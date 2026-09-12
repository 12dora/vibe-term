import type { LinkStream } from '@vibeterm/shared/link';
import type { RelayQuota, RelayRtcConfig } from '@vibeterm/shared/relay';
import { backoffDelayMs } from './ctl';
import { RELAY_PRESENCE_STALE_MS, type RelayPresence } from './relay-presence';
import type { RelayStreamOpener } from './relay-presence-types';
import type { InboundRelayHandler, MeshScheduler, UplinkState } from './types';
import { UPLINK_BACKOFF_MAX_MS, UPLINK_BACKOFF_MIN_MS } from './uplink-client';
import { normalizeHubEndpointUrl, sameHubUrl } from './uplink-pool-url';
import type { UplinkCtlMessage } from './uplink-protocol';

export type SecondaryUplink = {
  readonly hubUrl: string;
  state: UplinkState;
  readonly rttMs: number | null;
  readonly quota: RelayQuota | null;
  readonly rtc: RelayRtcConfig;
  readonly nodesViaRelay: number;
  awaitingToken: boolean;
  lastConnectError: { reason: string; at: number } | null;
  start(): void;
  stop(): Promise<void>;
  attemptConnect(signal?: AbortSignal): Promise<void>;
  waitUntilClosed(signal?: AbortSignal): Promise<void>;
  setOnRelayStream(handler: InboundRelayHandler | null): void;
  sendStatus(): void;
  sendCtl(msg: UplinkCtlMessage): void;
  openRelay(toNodeId: string): Promise<LinkStream>;
  onStateChange(cb: (state: UplinkState) => void): () => void;
};

export type RelaySecondaryRow = { url: string; priority: number; kicked: boolean };

export type RelaySecondaryAttachOptions = {
  rows: () => readonly RelaySecondaryRow[];
  primaryUrl: () => string | null;
  spawn: (url: string) => SecondaryUplink;
  presence: RelayPresence;
  scheduler: MeshScheduler;
  openPrimary: (peerNodeId: string) => Promise<LinkStream>;
  onRelayStream?: InboundRelayHandler;
  onExclusiveOffline?: (peerIds: string[]) => void;
  staleMs?: number;
};

type Slot = {
  url: string;
  abort: AbortController;
  client: SecondaryUplink | null;
  loop: Promise<void>;
  attempt: number;
};

/**
 * 每个非 primary、未被踢的 `mesh_relays` 行一条独立 `RelayUplinkClient`。
 * 单中继配置下不会造任何 secondary，行为与今天一致。
 */
export class RelaySecondaryAttach implements RelayStreamOpener {
  private readonly opts: RelaySecondaryAttachOptions;
  private readonly slots = new Map<string, Slot>();
  private readonly decays = new Map<string, { clear: () => void }>();
  private running = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RelaySecondaryAttachOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.queueReconcile();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.queueReconcile();
    const pending = [...this.slots.keys()].map((url) => this.drop(url, 'stop'));
    await Promise.all(pending);
  }

  /** `relayRows()` 或 primary 变化时重算要挂的 secondary 集合。 */
  reconcile(): Promise<void> {
    return this.queueReconcile();
  }

  async openRelayVia(url: string, peerNodeId: string): Promise<LinkStream> {
    const primary = this.opts.primaryUrl();
    if (primary && sameHubUrl(url, primary)) return this.opts.openPrimary(peerNodeId);
    const slot = this.slots.get(normalizeHubEndpointUrl(url));
    const client = slot?.client;
    if (!client || client.state !== 'online') throw new Error('uplink is not online');
    return client.openRelay(peerNodeId);
  }

  /** switch 前拆掉目标上的 secondary，避免与即将 promote 的 primary 双连。 */
  async release(url: string): Promise<void> {
    await this.drop(url, 'promoted');
  }

  client(url: string): SecondaryUplink | null {
    return this.slots.get(normalizeHubEndpointUrl(url))?.client ?? null;
  }

  connected(): SecondaryUplink[] {
    const out: SecondaryUplink[] = [];
    for (const slot of this.slots.values()) {
      if (slot.client?.state === 'online') out.push(slot.client);
    }
    return out;
  }

  sendStatusAll(): void {
    for (const slot of this.slots.values()) slot.client?.sendStatus();
  }

  noteKicked(url: string): void {
    void this.drop(url, 'gone').then(() => this.queueReconcile());
  }

  private queueReconcile(): Promise<void> {
    const next = this.chain.then(
      () => this.reconcileNow(),
      () => this.reconcileNow()
    );
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private secondaryUrls(rows: readonly RelaySecondaryRow[], primary: string | null): Set<string> {
    const wanted = new Set<string>();
    // 主中继尚未挂上时不要把所有行当 secondary，否则会和池抢同一 URL（单中继也会双连）。
    if (!primary) return wanted;
    for (const row of rows) {
      if (!sameHubUrl(row.url, primary)) wanted.add(normalizeHubEndpointUrl(row.url));
    }
    return wanted;
  }

  private async reconcileNow(): Promise<void> {
    const primary = this.opts.primaryUrl();
    this.opts.presence.setPrimary(primary);
    const rows = this.running ? this.opts.rows().filter((row) => !row.kicked) : [];
    for (const row of rows) this.opts.presence.setPriority(row.url, row.priority);
    const wanted = this.secondaryUrls(rows, primary);
    const keepPresence = [...(primary ? [primary] : []), ...rows.map((row) => row.url)];
    this.opts.presence.retainUrls(keepPresence);
    for (const key of [...this.slots.keys()]) {
      if (!wanted.has(key)) {
        await this.drop(key, primary && sameHubUrl(key, primary) ? 'promoted' : 'gone');
      }
    }
    if (!this.running) return;
    for (const url of wanted) {
      if (!this.slots.has(url)) this.spawnLoop(url);
    }
  }

  private spawnLoop(url: string): void {
    const key = normalizeHubEndpointUrl(url);
    if (this.slots.has(key)) return;
    const abort = new AbortController();
    const slot: Slot = { url: key, abort, client: null, loop: Promise.resolve(), attempt: 0 };
    this.slots.set(key, slot);
    slot.loop = this.runLoop(slot);
  }

  private async runLoop(slot: Slot): Promise<void> {
    while (this.running && !slot.abort.signal.aborted && this.stillWanted(slot.url)) {
      let client: SecondaryUplink;
      try {
        client = this.opts.spawn(slot.url);
      } catch {
        const delay = backoffDelayMs(slot.attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
        slot.attempt += 1;
        try {
          await this.opts.scheduler.sleep(delay, slot.abort.signal);
        } catch {
          break;
        }
        continue;
      }
      slot.client = client;
      if (this.opts.onRelayStream) {
        const inner = this.opts.onRelayStream;
        client.setOnRelayStream((stream, from, viaRelay) =>
          inner(stream, from, viaRelay ?? slot.url)
        );
      }
      const unsub = client.onStateChange((state) => this.onClientState(slot, client, state));
      try {
        client.start();
        await client.attemptConnect(slot.abort.signal);
        if (slot.abort.signal.aborted) break;
        slot.attempt = 0;
        this.clearDecay(slot.url);
        this.opts.presence.setConnected(slot.url, true, client.rttMs, this.opts.scheduler.now());
        await client.waitUntilClosed(slot.abort.signal);
      } catch {
        /* 连接失败或 aborted：下面统一拆掉再退避 */
      } finally {
        unsub();
        const now = this.opts.scheduler.now();
        this.opts.presence.markDisconnected(slot.url, now, this.staleMs());
        slot.client = null;
        try {
          await client.stop();
        } catch {
          /* 停失败不影响下一轮 */
        }
      }
      if (!this.running || slot.abort.signal.aborted || !this.stillWanted(slot.url)) break;
      this.scheduleDecay(slot.url);
      const delay = backoffDelayMs(slot.attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
      slot.attempt += 1;
      try {
        await this.opts.scheduler.sleep(delay, slot.abort.signal);
      } catch {
        break;
      }
    }
  }

  private onClientState(slot: Slot, client: SecondaryUplink, state: UplinkState): void {
    if (this.slots.get(slot.url)?.client !== client) return;
    const now = this.opts.scheduler.now();
    if (state === 'online') {
      this.clearDecay(slot.url);
      this.opts.presence.setConnected(slot.url, true, client.rttMs, now);
      return;
    }
    if (state === 'offline') {
      this.opts.presence.markDisconnected(slot.url, now, this.staleMs());
    }
  }

  private stillWanted(url: string): boolean {
    if (!this.running) return false;
    const primary = this.opts.primaryUrl();
    if (primary && sameHubUrl(url, primary)) return false;
    return this.opts.rows().some((row) => !row.kicked && sameHubUrl(row.url, url));
  }

  private async drop(url: string, reason: 'gone' | 'promoted' | 'stop'): Promise<void> {
    const key = normalizeHubEndpointUrl(url);
    const slot = this.slots.get(key);
    this.clearDecay(key);
    if (!slot) {
      if (reason === 'gone') this.opts.presence.remove(key);
      return;
    }
    slot.abort.abort();
    this.slots.delete(key);
    try {
      await slot.loop;
    } catch {
      /* loop 自己吞错误 */
    }
    if (slot.client) {
      try {
        await slot.client.stop();
      } catch {
        /* already stopped */
      }
      slot.client = null;
    }
    if (reason === 'gone') this.opts.presence.remove(key);
    else if (reason === 'stop') {
      this.opts.presence.markDisconnected(key, this.opts.scheduler.now(), this.staleMs());
    }
  }

  private scheduleDecay(url: string): void {
    this.clearDecay(url);
    const staleMs = this.staleMs();
    const handle = this.opts.scheduler.interval(() => {
      handle.clear();
      this.decays.delete(url);
      const exclusive = this.opts.presence.decay(url, this.opts.scheduler.now());
      if (exclusive.length > 0) this.opts.onExclusiveOffline?.(exclusive);
    }, staleMs);
    this.decays.set(url, handle);
  }

  private clearDecay(url: string): void {
    this.decays.get(url)?.clear();
    this.decays.delete(url);
  }

  private staleMs(): number {
    return this.opts.staleMs ?? RELAY_PRESENCE_STALE_MS;
  }
}
