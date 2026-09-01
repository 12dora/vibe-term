import { X509Certificate, createHash } from 'node:crypto';
import { canonicalHubUrl, hubHostFromUrl } from '@tmex/shared/auth';
import type { HubAdvertisement, HubMode } from '@tmex/shared/uplink';
import type { HubTrustStore } from '../auth/hub-trust-store';
import type { MeshHubRecord } from '../auth/mesh-hub-store';
import { hubListToRecords } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';
import { backoffDelayMs, defaultScheduler } from './ctl';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import {
  UPLINK_BACKOFF_MAX_MS,
  UPLINK_BACKOFF_MIN_MS,
  UplinkClient,
  type UplinkClientOptions,
  type UplinkWsFactory,
  uplinkWebSocketTls,
} from './uplink-client';
import type {
  UplinkCtlMessage,
  UplinkEnrollRedeemed,
  UplinkNodeList,
  UplinkRtcSignal,
} from './uplink-protocol';

export const UPLINK_POOL_FAIL_LIMIT = 3;
export const UPLINK_POOL_AUTH_DEADLINE_MS = 20_000;
export const UPLINK_POOL_PROBE_INTERVAL_MS = 60_000;
export const UPLINK_POOL_PROBE_TIMEOUT_MS = 5_000;
export const UPLINK_SEED_PRIORITY_BASE = 1_000;

export type UplinkCandidate = {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode;
  writerEpoch: number;
  priority: number;
  caFingerprint: string | null;
};

export type AttachedHub = {
  hubNodeId: string | null;
  publicUrl: string;
  mode: HubMode | null;
  writerEpoch: number | null;
  since: number;
};

export type UplinkPoolNodeListMeta = {
  hubNodeId: string | null;
  generation: number;
};

export type CreatePooledUplink = (opts: UplinkClientOptions) => UplinkClient;

export type UplinkPoolOptions = {
  identity: MeshIdentity;
  userId: string | (() => string);
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  statusProvider: () => UplinkStatus & { hub?: HubAdvertisement };
  candidates: () => UplinkCandidate[];
  hubTrust: HubTrustStore;
  wsFactory?: UplinkWsFactory;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  createClient?: CreatePooledUplink;
  probeHealthz?: (publicUrl: string, tlsCa: string[] | null, timeoutMs: number) => Promise<boolean>;
  fetchCaPem?: (publicUrl: string) => Promise<string>;
  fingerprintPem?: (pem: string) => string;
  onNodeList?: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onKeyLogFork?: (event: KeyLogForkEvent) => void;
  failLimit?: number;
  authDeadlineMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
};

export function normalizeHubEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return canonicalHubUrl(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function sameHubUrl(a: string, b: string): boolean {
  return normalizeHubEndpointUrl(a) === normalizeHubEndpointUrl(b);
}

export function mergeUplinkCandidates(
  stored: Array<{
    hubNodeId: string;
    publicUrl: string;
    mode: HubMode;
    writerEpoch: number;
    priority: number;
    caFingerprint: string | null;
  }>,
  seeds: string[]
): UplinkCandidate[] {
  const seen = new Set<string>();
  const out: UplinkCandidate[] = [];
  for (const row of stored) {
    const key = normalizeHubEndpointUrl(row.publicUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      hubNodeId: row.hubNodeId,
      publicUrl: row.publicUrl,
      mode: row.mode,
      writerEpoch: row.writerEpoch,
      priority: row.priority,
      caFingerprint: row.caFingerprint,
    });
  }
  let seedIndex = 0;
  for (const raw of seeds) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeHubEndpointUrl(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      hubNodeId: null,
      publicUrl: trimmed,
      mode: 'active',
      writerEpoch: 0,
      priority: UPLINK_SEED_PRIORITY_BASE + seedIndex,
      caFingerprint: null,
    });
    seedIndex += 1;
  }
  return out;
}

export function recordsFromNodeList(list: UplinkNodeList): Array<Omit<MeshHubRecord, 'updatedAt'>> {
  if (list.hubs && list.hubs.length > 0) return hubListToRecords(list.hubs);
  if (!list.hub) return [];
  return [
    {
      hubNodeId: list.hub.nodeId,
      publicUrl: list.hub.publicUrl,
      name: list.hub.name ?? null,
      mode: 'active',
      priority: 100,
      writerEpoch: list.writerEpoch ?? 1,
      caFingerprint: null,
      online: true,
      lastSeenAt: null,
    },
  ];
}

export function spkiFingerprintFromPem(pem: string): string {
  const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!match) throw new Error('PEM does not contain a certificate');
  const cert = new X509Certificate(match[0]);
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(spki).digest('hex');
}

export function joinHubPath(publicUrl: string, path: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${path}`;
}

export async function defaultProbeHealthz(
  publicUrl: string,
  tlsCa: string[] | null,
  timeoutMs: number
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init: RequestInit = { method: 'GET', signal: ac.signal, redirect: 'error' };
    const tls = uplinkWebSocketTls(tlsCa);
    if (tls) Object.assign(init, tls);
    const res = await fetch(joinHubPath(publicUrl, '/healthz'), init);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function defaultFetchCaPem(publicUrl: string): Promise<string> {
  const res = await fetch(joinHubPath(publicUrl, '/api/tls/ca.crt'), {
    redirect: 'error',
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  if (!res.ok) throw new Error('ca_unavailable');
  return res.text();
}

function fallbackCandidate(): UplinkCandidate {
  return {
    hubNodeId: null,
    publicUrl: 'http://127.0.0.1',
    mode: 'active',
    writerEpoch: 0,
    priority: UPLINK_SEED_PRIORITY_BASE,
    caFingerprint: null,
  };
}

export class UplinkPool {
  readonly identity: MeshIdentity;
  lastConnectError: { reason: string; at: number } | null = null;

  private readonly userIdOf: () => string;
  private readonly opts: UplinkPoolOptions;
  private readonly scheduler: MeshScheduler;
  private readonly createClient: CreatePooledUplink;
  private readonly failLimit: number;
  private readonly authDeadlineMs: number;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;

  private live: UplinkClient | null = null;
  private pending: UplinkClient | null = null;
  private attached: AttachedHub | null = null;
  private generation = 0;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private probe: { clear: () => void } | null = null;
  private wrapAttempt = 0;
  private relayHandler: InboundRelayHandler | null = null;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private readonly attachedListeners: Array<(hub: AttachedHub) => void> = [];
  private readonly detachedListeners: Array<() => void> = [];
  private readonly nodeListListeners: Array<
    (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void
  > = [];
  private liveStateOff: (() => void) | null = null;

  constructor(opts: UplinkPoolOptions) {
    this.opts = opts;
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.createClient = opts.createClient ?? ((clientOpts) => new UplinkClient(clientOpts));
    this.failLimit = opts.failLimit ?? UPLINK_POOL_FAIL_LIMIT;
    this.authDeadlineMs = opts.authDeadlineMs ?? UPLINK_POOL_AUTH_DEADLINE_MS;
    this.probeIntervalMs = opts.probeIntervalMs ?? UPLINK_POOL_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? UPLINK_POOL_PROBE_TIMEOUT_MS;
  }

  get userId(): string {
    return this.live?.userId ?? this.pending?.userId ?? this.userIdOf();
  }

  get state(): UplinkState {
    return this.live?.state ?? this.pending?.state ?? 'offline';
  }

  get link() {
    return this.live?.link ?? this.pending?.link ?? null;
  }

  get lastKeyLogHead() {
    return this.live?.lastKeyLogHead ?? this.pending?.lastKeyLogHead ?? null;
  }

  attachedHub(): AttachedHub | null {
    return this.attached;
  }

  candidates(): UplinkCandidate[] {
    const list = this.opts.candidates();
    return list.length > 0 ? list : [fallbackCandidate()];
  }

  currentGeneration(): number {
    return this.generation;
  }

  liveClient(): UplinkClient | null {
    return this.live;
  }

  onAttached(cb: (hub: AttachedHub) => void): () => void {
    this.attachedListeners.push(cb);
    return () => {
      const idx = this.attachedListeners.indexOf(cb);
      if (idx >= 0) this.attachedListeners.splice(idx, 1);
    };
  }

  onDetached(cb: () => void): () => void {
    this.detachedListeners.push(cb);
    return () => {
      const idx = this.detachedListeners.indexOf(cb);
      if (idx >= 0) this.detachedListeners.splice(idx, 1);
    };
  }

  onNodeList(cb: (list: UplinkNodeList, meta: UplinkPoolNodeListMeta) => void): () => void {
    this.nodeListListeners.push(cb);
    return () => {
      const idx = this.nodeListListeners.indexOf(cb);
      if (idx >= 0) this.nodeListListeners.splice(idx, 1);
    };
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
    this.live?.setOnRelayStream(handler);
    this.pending?.setOnRelayStream(handler);
  }

  start(connectOnce?: (signal: AbortSignal) => Promise<void>): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    if (connectOnce) {
      const first = this.candidates()[0] ?? fallbackCandidate();
      const client = this.spawn(first);
      this.live = client;
      this.bindLiveState(client);
      client.start(connectOnce);
      this.watchCustomOnline(client, first);
      this.loop = this.waitStop(this.stopAbort.signal);
      return;
    }
    this.loop = this.run(this.stopAbort.signal);
  }

  async connectWithLink(
    link: Parameters<UplinkClient['connectWithLink']>[0],
    signal?: AbortSignal
  ): Promise<void> {
    const client = this.requireLive();
    await client.connectWithLink(link, signal);
  }

  async stop(): Promise<void> {
    this.stopAbort?.abort();
    this.stopAbort = null;
    this.stopProbe();
    const live = this.live;
    const pending = this.pending;
    this.live = null;
    this.pending = null;
    if (this.attached) {
      this.attached = null;
      this.emitDetached();
    }
    this.unbindLiveState();
    const loop = this.loop;
    this.loop = null;
    await pending?.stop();
    await live?.stop();
    try {
      if (loop) await loop;
    } catch {
      /* cancelled */
    }
    this.emitState('offline');
  }

  sendCtl(msg: UplinkCtlMessage): void {
    this.requireLive().sendCtl(msg);
  }

  sendStatus(): void {
    this.live?.sendStatus();
  }

  sendStatusIfChanged(): boolean {
    return this.live?.sendStatusIfChanged() ?? false;
  }

  openRelay(toNodeId: string) {
    return this.requireLive().openRelay(toNodeId);
  }

  queryHubHead() {
    return this.requireLive().queryHubHead();
  }

  queryKeyLogAt(seq: bigint, timeoutMs?: number) {
    return this.requireLive().queryKeyLogAt(seq, timeoutMs);
  }

  appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs?: number,
    generation?: number
  ) {
    return this.requireLive().appendAndAck(record, timeoutMs, generation);
  }

  async switchTo(publicUrl: string): Promise<void> {
    const target = this.candidates().find((row) => sameHubUrl(row.publicUrl, publicUrl));
    if (!target) throw new Error(`unknown hub url: ${publicUrl}`);
    if (
      this.attached &&
      sameHubUrl(this.attached.publicUrl, publicUrl) &&
      this.live?.state === 'online'
    ) {
      return;
    }
    const signal = this.stopAbort?.signal;
    if (!signal || signal.aborted) throw new Error('aborted');
    const client = this.spawn(target);
    this.pending = client;
    try {
      await client.attemptConnect(signal);
      await this.promote(client, target);
    } catch (err) {
      if (this.pending === client) this.pending = null;
      await client.stop();
      throw err;
    }
  }

  private requireLive(): UplinkClient {
    const live = this.live;
    if (!live) throw new Error('uplink is not online');
    return live;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cands = this.candidates();
      let session = false;
      for (const cand of cands) {
        if (signal.aborted) return;
        session = await this.tryCandidate(cand, signal);
        if (session) break;
      }
      if (signal.aborted) return;
      if (session) {
        this.wrapAttempt = 0;
        try {
          await this.scheduler.sleep(
            backoffDelayMs(0, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS),
            signal
          );
        } catch {
          return;
        }
        continue;
      }
      const delay = backoffDelayMs(this.wrapAttempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
      this.wrapAttempt += 1;
      try {
        await this.scheduler.sleep(delay, signal);
      } catch {
        return;
      }
    }
  }

  private async tryCandidate(cand: UplinkCandidate, signal: AbortSignal): Promise<boolean> {
    const deadline = new AbortController();
    const combined = anyAbort(signal, deadline.signal);
    const deadlineStarted = this.scheduler.now();
    const sleeper = this.scheduler.sleep(this.authDeadlineMs, deadline.signal).then(
      () => {
        if (this.scheduler.now() - deadlineStarted < this.authDeadlineMs) return;
        if (!deadline.signal.aborted) deadline.abort();
      },
      () => {}
    );
    const client = this.spawn(cand);
    this.pending = client;
    let failures = 0;
    try {
      while (failures < this.failLimit && !combined.aborted) {
        try {
          await client.attemptConnect(combined);
          deadline.abort();
          await this.promote(client, cand);
          await this.waitActiveSession(client, signal);
          return true;
        } catch {
          failures += 1;
          this.lastConnectError = { reason: 'connect-failed', at: this.scheduler.now() };
          if (combined.aborted || failures >= this.failLimit) break;
        }
      }
      return false;
    } finally {
      deadline.abort();
      await sleeper.catch(() => {});
      if (this.pending === client) this.pending = null;
      if (this.live === client) {
        this.clearLive(client);
      }
      try {
        await client.stop();
      } catch {
        /* ignore */
      }
    }
  }

  private spawn(cand: UplinkCandidate): UplinkClient {
    const pin = this.opts.hubTrust.get(cand.publicUrl);
    const tlsCa = pin?.caPem ? [pin.caPem] : null;
    const wsFactory = this.opts.wsFactory ?? defaultWsFactory(tlsCa);
    const client = this.createClient({
      hubUrl: cand.publicUrl,
      identity: this.opts.identity,
      userId: this.userIdOf,
      keyLogApplier: this.opts.keyLogApplier,
      userStore: this.opts.userStore,
      statusProvider: this.opts.statusProvider,
      wsFactory,
      tlsCa,
      scheduler: this.scheduler,
      pingIntervalMs: this.opts.pingIntervalMs,
      onNodeList: (list) => this.dispatchNodeList(client, list, cand.hubNodeId),
      onRtcSignal: (msg) => {
        if (this.live !== client) return;
        this.opts.onRtcSignal?.(msg);
      },
      onEnrollRedeemed: (msg) => {
        if (this.live !== client) return;
        this.opts.onEnrollRedeemed?.(msg);
      },
      onKeyLogFork: this.opts.onKeyLogFork,
    });
    client.setOnRelayStream(this.relayHandler);
    return client;
  }

  private async promote(client: UplinkClient, cand: UplinkCandidate): Promise<void> {
    const old = this.live !== client ? this.live : null;
    this.generation += 1;
    this.pending = null;
    this.live = client;
    this.bindLiveState(client);
    client.setOnRelayStream(this.relayHandler);
    this.attached = {
      hubNodeId: cand.hubNodeId,
      publicUrl: cand.publicUrl,
      mode: cand.mode,
      writerEpoch: cand.writerEpoch,
      since: this.scheduler.now(),
    };
    this.emitAttached(this.attached);
    this.emitState(client.state);
    client.sendStatus();
    this.syncProbe();
    if (old) {
      old.setOnRelayStream(null);
      try {
        await old.stop();
      } catch {
        /* ignore */
      }
    }
  }

  private dispatchNodeList(
    client: UplinkClient,
    list: UplinkNodeList,
    hubNodeId: string | null
  ): void {
    if (this.live !== client) return;
    const meta = {
      hubNodeId: list.hub?.nodeId ?? hubNodeId,
      generation: this.generation,
    };
    this.opts.onNodeList?.(list, meta);
    for (const cb of this.nodeListListeners) {
      try {
        cb(list, meta);
      } catch {
        /* listener errors must not break the pool */
      }
    }
    void this.pinAdvertisedCas(list);
  }

  private async pinAdvertisedCas(list: UplinkNodeList): Promise<void> {
    const hubs = list.hubs ?? [];
    for (const hub of hubs) {
      const advertised = hub.caFingerprint?.trim().toLowerCase();
      if (!advertised) continue;
      if (this.opts.hubTrust.get(hub.publicUrl)) continue;
      try {
        const pem = await (this.opts.fetchCaPem ?? defaultFetchCaPem)(hub.publicUrl);
        const fingerprint = (this.opts.fingerprintPem ?? spkiFingerprintFromPem)(pem).toLowerCase();
        if (fingerprint !== advertised) continue;
        this.opts.hubTrust.put({
          hubUrl: hub.publicUrl,
          caPem: pem,
          fingerprint,
        });
      } catch {
        /* pin is best-effort; next node.list retries */
      }
    }
  }

  private async waitActiveSession(origin: UplinkClient, signal: AbortSignal): Promise<void> {
    let current = origin;
    while (this.live && !signal.aborted) {
      current = this.live;
      await this.waitWhileLive(current, signal);
      if (this.live === current) break;
    }
  }

  private async waitWhileLive(client: UplinkClient, signal: AbortSignal): Promise<void> {
    if (this.live !== client || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const off = client.onStateChange((state) => {
        if (state === 'offline' || this.live !== client) finish();
      });
      if (signal.aborted || this.live !== client || client.state === 'offline') {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
      void client.waitUntilClosed(signal).then(finish);
    });
  }

  private clearLive(client: UplinkClient): void {
    if (this.live !== client) return;
    this.live = null;
    this.unbindLiveState();
    this.stopProbe();
    if (this.attached) {
      this.attached = null;
      this.emitDetached();
    }
    this.emitState('offline');
  }

  private watchCustomOnline(client: UplinkClient, cand: UplinkCandidate): void {
    client.onStateChange((state) => {
      if (state === 'online' && this.live === client) {
        this.generation += 1;
        this.attached = {
          hubNodeId: cand.hubNodeId,
          publicUrl: cand.publicUrl,
          mode: cand.mode,
          writerEpoch: cand.writerEpoch,
          since: this.scheduler.now(),
        };
        this.emitAttached(this.attached);
      } else if (state === 'offline' && this.live === client && this.attached) {
        this.attached = null;
        this.emitDetached();
      }
    });
  }

  private bindLiveState(client: UplinkClient): void {
    this.unbindLiveState();
    this.liveStateOff = client.onStateChange((state) => {
      if (this.live === client) this.emitState(state);
    });
  }

  private unbindLiveState(): void {
    this.liveStateOff?.();
    this.liveStateOff = null;
  }

  private syncProbe(): void {
    this.stopProbe();
    const attached = this.attached;
    if (!attached) return;
    const idx = this.candidates().findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
    if (idx <= 0) return;
    this.probe = this.scheduler.interval(() => {
      void this.probePreferred();
    }, this.probeIntervalMs);
  }

  private stopProbe(): void {
    this.probe?.clear();
    this.probe = null;
  }

  private async probePreferred(): Promise<void> {
    const attached = this.attached;
    if (!attached) return;
    const cands = this.candidates();
    const idx = cands.findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
    if (idx <= 0) {
      this.stopProbe();
      return;
    }
    const probe = this.opts.probeHealthz ?? defaultProbeHealthz;
    for (let i = 0; i < idx; i += 1) {
      const pref = cands[i];
      if (!pref) continue;
      const pin = this.opts.hubTrust.get(pref.publicUrl);
      const tlsCa = pin?.caPem ? [pin.caPem] : null;
      const ok = await probe(pref.publicUrl, tlsCa, this.probeTimeoutMs);
      if (!ok) continue;
      try {
        await this.switchTo(pref.publicUrl);
      } catch {
        /* keep current attachment */
      }
      return;
    }
  }

  private emitState(state: UplinkState): void {
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        /* listener errors must not break the pool */
      }
    }
  }

  private emitAttached(hub: AttachedHub): void {
    for (const cb of this.attachedListeners) {
      try {
        cb(hub);
      } catch {
        /* ignore */
      }
    }
  }

  private emitDetached(): void {
    for (const cb of this.detachedListeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  private async waitStop(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function defaultWsFactory(tlsCa: string[] | null): UplinkWsFactory {
  return (url) => {
    const tls = uplinkWebSocketTls(tlsCa);
    return tls ? new WebSocket(url, tls as never) : new WebSocket(url);
  };
}

function anyAbort(a: AbortSignal, b: AbortSignal): AbortSignal {
  const out = new AbortController();
  const abort = () => {
    if (!out.signal.aborted) out.abort();
  };
  if (a.aborted || b.aborted) {
    abort();
    return out.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return out.signal;
}

export function attachedHubHost(
  attached: AttachedHub | null,
  fallbackUrl?: string | null
): string | null {
  const url = attached?.publicUrl ?? fallbackUrl;
  if (!url) return null;
  try {
    return hubHostFromUrl(url);
  } catch {
    return null;
  }
}
