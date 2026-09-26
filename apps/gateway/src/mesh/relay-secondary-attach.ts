import type { LinkStream } from '@vibeterm/shared/link';
import type { RelayQuota, RelayRtcConfig } from '@vibeterm/shared/relay';
import { RELAY_PRESENCE_STALE_MS, type RelayPresence } from './relay-presence';
import type { RelayStreamOpener } from './relay-presence-types';
import {
  type SecondaryRetryHost,
  logSecondaryOnline,
  noteSecondaryConnectFail,
  sleepAfterSecondaryFail,
  sleepBeforeSecondaryRetry,
} from './relay-secondary-retry';
import type { InboundRelayHandler, MeshScheduler, UplinkState } from './types';
import { watchPredicate } from './uplink-pool';
import { normalizeUplinkEndpointUrl, sameUplinkUrl } from './uplink-pool-url';
import type { UplinkCtlMessage } from './uplink-protocol';
import { bindRelayStreamClient, unbindRelayDrainOwner } from './uplink-relay-drain';

export type SecondaryUplink = {
  readonly uplinkUrl: string;
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

export type RelaySecondaryRow = {
  url: string;
  priority: number;
  kicked: boolean;
  /** sha256(tenantId || token) hex；与 spawn 时记下的值不同则拆掉重挂。 */
  credentialKey: string;
};

export type RelaySecondaryAttachOptions = {
  rows: () => readonly RelaySecondaryRow[];
  primaryUrl: () => string | null;
  /** 池正在拨、但还不是已挂上的主中继。只排除这一条。 */
  excludeUrl?: () => string | null;
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
  credentialKey: string;
  abort: AbortController;
  client: SecondaryUplink | null;
  handedOff: SecondaryUplink | null;
  loop: Promise<void>;
  attempt: number;
  wake: AbortController;
};

/**
 * 每个非 primary、未被踢的 `mesh_relays` 行一条独立 `RelayUplinkClient`。
 * 单中继配置下不会造任何 secondary，行为与今天一致。
 */
export class RelaySecondaryAttach implements RelayStreamOpener {
  private readonly opts: RelaySecondaryAttachOptions;
  private readonly slots = new Map<string, Slot>();
  private readonly failLogAt = new Map<string, number>();
  private readonly onlineLogAt = new Map<string, number>();
  private readonly slotStateListeners: Array<(url: string, state: UplinkState) => void> = [];
  private running = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly retiringUrls = new Set<string>();

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
    if (primary && sameUplinkUrl(url, primary)) return this.opts.openPrimary(peerNodeId);
    const slot = this.slots.get(normalizeUplinkEndpointUrl(url));
    const client = slot?.client;
    if (!client || client.state !== 'online') throw new Error('uplink is not online');
    return client.openRelay(peerNodeId);
  }

  async release(url: string): Promise<void> {
    await this.drop(url, 'promoted');
  }

  async detachOnline(url: string): Promise<SecondaryUplink | null> {
    const key = normalizeUplinkEndpointUrl(url);
    const slot = this.slots.get(key);
    const client = slot?.client;
    if (!slot || !client || client.state !== 'online' || !hasPrimaryWiring(client)) return null;
    slot.handedOff = client;
    slot.client = null;
    this.slots.delete(key);
    slot.abort.abort();
    await slot.loop.catch(() => undefined);
    return client;
  }

  /** 本机网络变了：清掉退避。池正占用的 URL 不叫醒，避免和主拨号抢注册。 */
  resetAttempts(): void {
    for (const slot of this.slots.values()) {
      slot.attempt = 0;
      if (this.excluded(slot.url) || this.retiringUrls.has(slot.url)) continue;
      slot.wake.abort();
    }
  }

  async releaseNotOnline(url: string): Promise<void> {
    const key = normalizeUplinkEndpointUrl(url);
    const slot = this.slots.get(key);
    if (!slot || slot.client?.state === 'online') return;
    await this.drop(key, 'stop');
  }

  /** 把刚卸下的主连接原地收成 secondary，不再另拨、不再排空。 */
  adoptOnline(client: SecondaryUplink): boolean {
    if (!this.running || client.state !== 'online') return false;
    const key = normalizeUplinkEndpointUrl(client.uplinkUrl);
    const primary = this.opts.primaryUrl();
    if ((primary && sameUplinkUrl(key, primary)) || this.slots.has(key)) return false;
    if (this.retiringUrls.has(key)) return false;
    const row = this.opts.rows().find((item) => !item.kicked && sameUplinkUrl(item.url, key));
    if (!row) return false;
    (client as SecondaryUplink & { releasePrimaryWiring?: () => void }).releasePrimaryWiring?.();
    const slot = this.blankSlot(key, row.credentialKey);
    slot.client = client;
    this.slots.set(key, slot);
    this.bindRelayStream(slot, client);
    slot.loop = this.watchAdopted(slot, client);
    return true;
  }

  noteRetiring(url: string): void {
    this.retiringUrls.add(normalizeUplinkEndpointUrl(url));
  }

  clearRetiring(url: string): void {
    if (this.retiringUrls.delete(normalizeUplinkEndpointUrl(url))) void this.queueReconcile();
  }

  client(url: string): SecondaryUplink | null {
    return this.slots.get(normalizeUplinkEndpointUrl(url))?.client ?? null;
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

  onSlotState(cb: (url: string, state: UplinkState) => void): () => void {
    this.slotStateListeners.push(cb);
    return () => {
      const idx = this.slotStateListeners.indexOf(cb);
      if (idx >= 0) this.slotStateListeners.splice(idx, 1);
    };
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

  /** 排除 primary / 池正在拨的 URL；primary 为空时保住未冲突的已有 secondary。 */
  private wantedSecondaries(
    rows: readonly RelaySecondaryRow[],
    primary: string | null
  ): Map<string, string> {
    const wanted = new Map<string, string>();
    const exclude = this.opts.excludeUrl?.() ?? null;
    if (!primary) {
      if (this.running) {
        for (const [url, slot] of this.slots) {
          if (this.retiringUrls.has(url)) continue;
          wanted.set(url, slot.credentialKey);
        }
      }
      return wanted;
    }
    for (const row of rows) {
      if (sameUplinkUrl(row.url, primary)) continue;
      const key = normalizeUplinkEndpointUrl(row.url);
      if (this.retiringUrls.has(key)) continue;
      if (exclude && sameUplinkUrl(row.url, exclude)) {
        const slot = this.slots.get(key);
        if (slot) wanted.set(key, slot.credentialKey);
        continue;
      }
      wanted.set(key, row.credentialKey);
    }
    return wanted;
  }

  private async reconcileNow(): Promise<void> {
    const primary = this.opts.primaryUrl();
    this.opts.presence.setPrimary(primary);
    const rows = this.running ? this.opts.rows().filter((row) => !row.kicked) : [];
    for (const row of rows) this.opts.presence.setPriority(row.url, row.priority);
    for (const key of [...this.slots.keys()]) {
      if (this.retiringUrls.has(key)) await this.drop(key, 'stop');
    }
    const wanted = this.wantedSecondaries(rows, primary);
    const keepPresence = [...(primary ? [primary] : []), ...rows.map((row) => row.url)];
    this.opts.presence.retainUrls(keepPresence);
    await this.dropStaleSlots(wanted, primary);
    if (!this.running) return;
    for (const [url, credentialKey] of wanted) {
      if (!this.slots.has(url)) this.spawnLoop(url, credentialKey);
    }
  }

  private async dropStaleSlots(wanted: Map<string, string>, primary: string | null): Promise<void> {
    for (const key of [...this.slots.keys()]) {
      const nextKey = wanted.get(key);
      if (nextKey !== undefined && this.slots.get(key)?.credentialKey === nextKey) continue;
      await this.drop(key, staleDropReason(key, nextKey, primary, this.opts.rows()));
    }
  }

  private spawnLoop(url: string, credentialKey: string): void {
    const key = normalizeUplinkEndpointUrl(url);
    if (this.slots.has(key)) return;
    const slot = this.blankSlot(key, credentialKey);
    this.slots.set(key, slot);
    slot.loop = this.runLoop(slot);
  }

  private blankSlot(url: string, credentialKey: string): Slot {
    return {
      url,
      credentialKey,
      abort: new AbortController(),
      client: null,
      handedOff: null,
      loop: Promise.resolve(),
      attempt: 0,
      wake: new AbortController(),
    };
  }

  private async runLoop(slot: Slot): Promise<void> {
    try {
      while (
        this.running &&
        !slot.abort.signal.aborted &&
        this.stillWanted(slot.url) &&
        !this.excluded(slot.url)
      ) {
        if (await this.runSlotAttempt(slot)) break;
      }
    } finally {
      this.releaseSlot(slot);
    }
  }

  /** slots 里只保留还活着的 loop；自然退出也要走 drop 同款删除，否则 reconcile 不会再 spawn。 */
  private releaseSlot(slot: Slot): void {
    if (this.slots.get(slot.url) !== slot) return;
    this.clearFailLogs(slot.url);
    this.slots.delete(slot.url);
    if (this.running) void this.queueReconcile();
  }

  private async runSlotAttempt(slot: Slot): Promise<boolean> {
    let client: SecondaryUplink;
    try {
      client = this.opts.spawn(slot.url);
    } catch {
      return sleepAfterSecondaryFail(slot, this.retryHost());
    }
    slot.client = client;
    this.bindRelayStream(slot, client);
    const unsub = client.onStateChange((state) => this.onClientState(slot, client, state));
    const stopWatch = watchPredicate(
      () => !this.stillWanted(slot.url),
      () => slot.abort.abort()
    );
    let closeReason = '';
    let retryDelay: number | null = null;
    try {
      client.start();
      await client.attemptConnect(slot.abort.signal);
      if (slot.abort.signal.aborted) return true;
      slot.attempt = 0;
      this.opts.presence.noteLink(
        slot.url,
        true,
        client.rttMs,
        this.opts.scheduler.now(),
        this.staleMs()
      );
      logSecondaryOnline(this.retryHost(), slot.url);
      await client.waitUntilClosed(slot.abort.signal);
    } catch (err) {
      retryDelay = noteSecondaryConnectFail(slot, client, err, this.retryHost());
    } finally {
      stopWatch();
      unsub();
      closeReason = client.lastConnectError?.reason ?? closeReason;
      await this.finishSlotAttempt(slot, client);
    }
    if (
      !this.running ||
      slot.abort.signal.aborted ||
      !this.stillWanted(slot.url) ||
      this.excluded(slot.url)
    ) {
      return true;
    }
    return sleepBeforeSecondaryRetry(slot, closeReason, retryDelay, this.retryHost());
  }

  private retryHost(): SecondaryRetryHost {
    return {
      scheduler: this.opts.scheduler,
      failLogAt: this.failLogAt,
      onlineLogAt: this.onlineLogAt,
    };
  }

  private async watchAdopted(slot: Slot, client: SecondaryUplink): Promise<void> {
    const unsub = client.onStateChange((state) => this.onClientState(slot, client, state));
    this.opts.presence.noteLink(
      slot.url,
      true,
      client.rttMs,
      this.opts.scheduler.now(),
      this.staleMs()
    );
    let handedBack = false;
    try {
      await client.waitUntilClosed(slot.abort.signal);
    } finally {
      unsub();
      handedBack = slot.handedOff === client;
      slot.client = null;
    }
    if (handedBack) return;
    unbindRelayDrainOwner(client, slot.url);
    this.opts.presence.noteLink(slot.url, false, null, this.opts.scheduler.now(), this.staleMs());
    try {
      await client.stop();
    } catch {
      /* already stopped */
    }
    this.releaseSlot(slot);
  }

  private async finishSlotAttempt(slot: Slot, client: SecondaryUplink): Promise<void> {
    if (slot.handedOff === client) {
      slot.client = null;
      return;
    }
    slot.client = null;
    this.opts.presence.noteLink(slot.url, false, null, this.opts.scheduler.now(), this.staleMs());
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
  }

  private bindRelayStream(slot: Slot, client: SecondaryUplink): void {
    if (!this.opts.onRelayStream) return;
    const inner = this.opts.onRelayStream;
    client.setOnRelayStream((stream, from, viaRelay) => {
      bindRelayStreamClient(stream, client);
      inner(stream, from, viaRelay ?? slot.url);
    });
  }

  private onClientState(slot: Slot, client: SecondaryUplink, state: UplinkState): void {
    if (this.slots.get(slot.url)?.client !== client) return;
    const now = this.opts.scheduler.now();
    if (state === 'online') {
      this.opts.presence.noteLink(slot.url, true, client.rttMs, now, this.staleMs());
    } else if (state === 'offline') {
      this.opts.presence.noteLink(slot.url, false, null, now, this.staleMs());
    }
    for (const cb of this.slotStateListeners) cb(slot.url, state);
  }

  private stillWanted(url: string): boolean {
    if (!this.running) return false;
    const primary = this.opts.primaryUrl();
    if (primary && sameUplinkUrl(url, primary)) return false;
    return this.opts.rows().some((row) => !row.kicked && sameUplinkUrl(row.url, url));
  }

  private excluded(url: string): boolean {
    const exclude = this.opts.excludeUrl?.() ?? null;
    return Boolean(exclude && sameUplinkUrl(url, exclude));
  }

  private async drop(url: string, reason: 'gone' | 'promoted' | 'stop'): Promise<void> {
    const key = normalizeUplinkEndpointUrl(url);
    const slot = this.slots.get(key);
    this.clearFailLogs(key);
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
      this.opts.presence.noteLink(key, false, null, this.opts.scheduler.now(), this.staleMs());
    }
  }

  private clearFailLogs(url: string): void {
    this.failLogAt.delete(url);
    this.onlineLogAt.delete(url);
  }

  private staleMs(): number {
    return this.opts.staleMs ?? RELAY_PRESENCE_STALE_MS;
  }
}

function hasPrimaryWiring(client: SecondaryUplink): boolean {
  return typeof (client as { adoptPrimaryWiring?: unknown }).adoptPrimaryWiring === 'function';
}

function staleDropReason(
  key: string,
  nextKey: string | undefined,
  primary: string | null,
  rows: readonly RelaySecondaryRow[]
): 'gone' | 'promoted' | 'stop' {
  if (nextKey === undefined && primary && sameUplinkUrl(key, primary)) return 'promoted';
  const stillConfigured = rows.some((row) => !row.kicked && sameUplinkUrl(row.url, key));
  return stillConfigured ? 'stop' : 'gone';
}
