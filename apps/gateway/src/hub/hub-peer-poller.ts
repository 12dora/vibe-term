/**
 * Hub 间状态探测。对端 GET /api/hub/status 可信，当且仅当：
 * 1. URL 经 TLS 认证（HubTrustStore 的 per-URL CA pin；无 pin 的 https 走系统 CA）；
 * 2. 返回的 32-hex hubNodeId 在本机 TMEX_HUB_PEERS allowlist 中，且与 mesh_hubs 行 id 一致。
 * 未授权的 URL / id 不能 fencing 本机。
 */
import type { HubAdvertisement, HubMode } from '@tmex/shared/uplink';
import type { HubTrustStore } from '../auth/hub-trust-store';
import type { MeshHubRecord, MeshHubStore } from '../auth/mesh-hub-store';
import { uplinkWebSocketTls } from '../mesh/uplink-client';
import { jitteredIntervalMs, joinHubPath } from '../mesh/uplink-pool';

export const HUB_PEER_POLL_START_DELAY_MS = 2_000;
export const HUB_PEER_POLL_INTERVAL_MS = 60_000;
export const HUB_PEER_POLL_TIMEOUT_MS = 5_000;
export const HUB_PEER_POLL_JITTER = 0.2;
export const HUB_PEER_POLL_FAIL_LIMIT = 3;
export const HUB_PEER_TLS_LOG_INTERVAL_MS = 10 * 60 * 1000;

const HUB_NODE_ID_HEX = /^[0-9a-f]{32}$/i;

export type HubPeerStatusBody = {
  hubNodeId: string;
  publicUrl: string;
  mode: HubMode;
  priority: number;
  writerEpoch: number;
  name?: string;
  caFingerprint?: string | null;
};

export type HubPeerFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type HubPeerPollerOptions = {
  meshHubs: MeshHubStore;
  selfHubId: () => string | undefined;
  isAuthorized: (hubNodeId: string) => boolean;
  applyStatus: (hubNodeId: string, ad: HubAdvertisement) => void;
  onChanged?: () => void;
  now?: () => number;
  fetch?: HubPeerFetch;
  hubTrust?: HubTrustStore;
  startDelayMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  jitter?: number;
  failLimit?: number;
};

export function peerPollDelayMs(
  intervalMs = HUB_PEER_POLL_INTERVAL_MS,
  jitter = HUB_PEER_POLL_JITTER
): number {
  return jitteredIntervalMs(intervalMs, jitter);
}

export class HubPeerPoller {
  private readonly meshHubs: MeshHubStore;
  private readonly selfHubId: () => string | undefined;
  private readonly isAuthorized: (hubNodeId: string) => boolean;
  private readonly applyStatus: (hubNodeId: string, ad: HubAdvertisement) => void;
  private readonly onChanged?: () => void;
  private readonly now: () => number;
  private readonly fetchImpl?: HubPeerFetch;
  private readonly hubTrust?: HubTrustStore;
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly jitter: number;
  private readonly failLimit: number;
  private readonly failCounts = new Map<string, number>();
  private readonly lastTlsLogAt = new Map<string, number>();
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private readonly stopAbort = new AbortController();

  constructor(opts: HubPeerPollerOptions) {
    this.meshHubs = opts.meshHubs;
    this.selfHubId = opts.selfHubId;
    this.isAuthorized = opts.isAuthorized;
    this.applyStatus = opts.applyStatus;
    this.onChanged = opts.onChanged;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch;
    this.hubTrust = opts.hubTrust;
    this.startDelayMs = opts.startDelayMs ?? HUB_PEER_POLL_START_DELAY_MS;
    this.intervalMs = opts.intervalMs ?? HUB_PEER_POLL_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? HUB_PEER_POLL_TIMEOUT_MS;
    this.jitter = opts.jitter ?? HUB_PEER_POLL_JITTER;
    this.failLimit = opts.failLimit ?? HUB_PEER_POLL_FAIL_LIMIT;
  }

  start(): void {
    if (this.stopped || this.startTimer || this.intervalTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.stopped) return;
      void this.pollNow();
      this.armInterval();
    }, this.startDelayMs);
    unrefTimer(this.startTimer);
  }

  stop(): void {
    this.stopped = true;
    this.dirty = false;
    if (!this.stopAbort.signal.aborted) this.stopAbort.abort();
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  pollNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    const run = this.runLoop();
    this.inFlight = run;
    return run;
  }

  private async runLoop(): Promise<void> {
    try {
      do {
        this.dirty = false;
        if (this.stopped) return;
        await this.pollAll();
      } while (this.dirty && !this.stopped);
    } catch {
      /* db closed after mesh.stop without hub.stop */
    } finally {
      this.inFlight = null;
    }
  }

  private armInterval(): void {
    if (this.stopped) return;
    this.intervalTimer = setTimeout(
      () => {
        this.intervalTimer = null;
        if (this.stopped) return;
        void this.pollNow();
        this.armInterval();
      },
      peerPollDelayMs(this.intervalMs, this.jitter)
    );
    unrefTimer(this.intervalTimer);
  }

  private peers(): MeshHubRecord[] {
    if (this.stopped) return [];
    try {
      const self = this.selfHubId()?.toLowerCase();
      return this.meshHubs.list().filter((row) => {
        const id = row.hubNodeId.toLowerCase();
        if (self && id === self) return false;
        if (!row.publicUrl) return false;
        return this.isAuthorized(id);
      });
    } catch {
      return [];
    }
  }

  private async pollAll(): Promise<void> {
    let changed = false;
    for (const row of this.peers()) {
      if (this.stopped) return;
      const result = await this.pollOne(row);
      if (result) changed = true;
    }
    if (changed && !this.stopped) {
      try {
        this.onChanged?.();
      } catch {
        /* ignore */
      }
    }
  }

  private async pollOne(row: MeshHubRecord): Promise<boolean> {
    if (this.stopped) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    unrefTimer(timer);
    const onStop = () => ac.abort();
    this.stopAbort.signal.addEventListener('abort', onStop);
    if (this.stopAbort.signal.aborted) ac.abort();
    try {
      const res = await this.fetchStatus(row.publicUrl, ac.signal);
      if (this.stopped) return false;
      if (!res.ok) {
        return this.noteFailure(row, `http_${res.status}`);
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (err) {
        return this.noteFailure(row, err);
      }
      if (this.stopped) return false;
      const body = parsePeerStatusBody(raw);
      if (!body) return this.noteFailure(row, 'invalid_status_body');
      if (body.hubNodeId !== row.hubNodeId.toLowerCase()) {
        console.warn(
          `[hub] ignored peer status: hubNodeId mismatch url=${row.publicUrl} expected=${row.hubNodeId} got=${body.hubNodeId}`
        );
        return false;
      }
      this.failCounts.delete(row.hubNodeId);
      const ad: HubAdvertisement = {
        publicUrl: body.publicUrl,
        mode: body.mode,
        priority: body.priority,
        writerEpoch: body.writerEpoch,
      };
      if (body.caFingerprint !== undefined) ad.caFingerprint = body.caFingerprint;
      try {
        this.applyStatus(row.hubNodeId, ad);
      } catch {
        return false;
      }
      return true;
    } catch (err) {
      if (this.stopped) return false;
      return this.noteFailure(row, err);
    } finally {
      clearTimeout(timer);
      this.stopAbort.signal.removeEventListener('abort', onStop);
    }
  }

  private async fetchStatus(publicUrl: string, signal: AbortSignal): Promise<Response> {
    const url = joinHubPath(publicUrl, '/api/hub/status');
    const init: RequestInit = { method: 'GET', signal, redirect: 'error' };
    if (this.fetchImpl) return this.fetchImpl(url, init);
    let pinCa: string | null = null;
    try {
      pinCa = this.hubTrust?.get(publicUrl)?.caPem ?? null;
    } catch {
      pinCa = null;
    }
    const tls = uplinkWebSocketTls(pinCa ? [pinCa] : null);
    if (tls) Object.assign(init, tls);
    return fetch(url, init);
  }

  private noteFailure(row: MeshHubRecord, err: unknown): boolean {
    if (this.stopped) return false;
    if (isTlsError(err)) this.warnTls(row.publicUrl, err);
    const next = (this.failCounts.get(row.hubNodeId) ?? 0) + 1;
    this.failCounts.set(row.hubNodeId, next);
    if (next < this.failLimit) return false;
    try {
      const existing = this.meshHubs.get(row.hubNodeId);
      if (!existing || !existing.online) return false;
      this.meshHubs.upsert({ ...existing, online: false }, this.now());
      return true;
    } catch {
      return false;
    }
  }

  private warnTls(publicUrl: string, err: unknown): void {
    const now = this.now();
    const prev = this.lastTlsLogAt.get(publicUrl);
    if (prev !== undefined && now - prev < HUB_PEER_TLS_LOG_INTERVAL_MS) return;
    this.lastTlsLogAt.set(publicUrl, now);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[hub] peer status TLS failed url=${publicUrl} err=${msg}`);
  }
}

function parsePeerStatusBody(raw: unknown): HubPeerStatusBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.hubNodeId !== 'string' || !HUB_NODE_ID_HEX.test(o.hubNodeId)) return null;
  if (typeof o.publicUrl !== 'string' || o.publicUrl.length === 0) return null;
  if (o.mode !== 'active' && o.mode !== 'standby') return null;
  if (typeof o.priority !== 'number' || !Number.isInteger(o.priority) || o.priority < 0) {
    return null;
  }
  if (typeof o.writerEpoch !== 'number' || !Number.isInteger(o.writerEpoch) || o.writerEpoch < 0) {
    return null;
  }
  const body: HubPeerStatusBody = {
    hubNodeId: o.hubNodeId.toLowerCase(),
    publicUrl: o.publicUrl,
    mode: o.mode,
    priority: o.priority,
    writerEpoch: o.writerEpoch,
  };
  if (typeof o.name === 'string' && o.name.trim()) body.name = o.name.trim();
  if (o.caFingerprint === null) body.caFingerprint = null;
  else if (typeof o.caFingerprint === 'string') body.caFingerprint = o.caFingerprint;
  return body;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function isTlsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const text = `${msg} ${code}`.toLowerCase();
  return (
    text.includes('tls') ||
    text.includes('cert') ||
    text.includes('ssl') ||
    text.includes('unable_to_verify') ||
    text.includes('err_tls')
  );
}
