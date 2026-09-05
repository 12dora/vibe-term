import type { LinkSession } from '@tmex/shared/link';
import { backoffDelayMs, isRecord } from './ctl';
import type { RtcSignalMessage } from './mesh-deps';
import type { IncomingWakeGate, RtcWakeGate, WakeGate } from './peer-rtc-wake';
import type { RtcSignaling, RtcWakeFields } from './rtc/ice';
import {
  type DcRearmSource,
  RTC_DIAL_BREAKER_HEALTHY_MS,
  RTC_DIAL_FORCE_PROBE_MS,
  type RtcDialBreaker,
  createGatewayRtcDialBreaker,
} from './rtc/rtc-dial-breaker';
import type { MeshScheduler, PeerTransportKind } from './types';

export const PEER_UPGRADE_COOLDOWN_MS = 10_000;
export const PEER_UPGRADE_SCAN_MS = 15_000;
export const PEER_UPGRADE_BACKOFF_CAP_MS = 5 * 60 * 1000;
export const PEER_UPGRADE_MAX_INFLIGHT = 4;
export const PEER_DC_UPGRADE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
export const PEER_DC_UPGRADE_RETRY_TAIL_MS = 120_000;
export const PEER_MAX_ENDPOINTS = 16;
export const PEER_MAX_ENDPOINT_LENGTH = 256;

export type UpgradeGate = {
  nextEligibleAt: number;
  failures: number;
  coalesced: boolean;
  scheduled: boolean;
};

export type DcUpgradeRetry = {
  attempt: number;
  abort: AbortController | null;
};

export type DcUpgradeLivePeer = {
  retiring: boolean;
  transport: PeerTransportKind;
  peerNodeId: string;
  quiesceCapable: boolean;
  session: LinkSession;
  dcAttemptId: string | null;
};

export type DcUpgradePorts = {
  scheduler: MeshScheduler;
  live: () => Map<string, DcUpgradeLivePeer>;
  dialDc: (nodeId: string) => Promise<LinkSession>;
  shouldTryDc: (nodeId: string) => boolean;
  dcCapable: (nodeId: string) => boolean;
  emitLinkInfo: (live: DcUpgradeLivePeer) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  stopped: () => boolean;
  stopSignal: () => AbortSignal;
  isTrusted: (nodeId: string) => boolean;
  pending: () => Map<string, Promise<LinkSession>>;
  upgrading: () => Map<string, Promise<LinkSession>>;
  probeQuiesce: (live: DcUpgradeLivePeer) => void;
  hasWsSecureCandidate: (nodeId: string) => boolean;
  lostDirect: () => Set<string>;
};

export class DcUpgradeCoordinator {
  readonly upgradeGate = new Map<string, UpgradeGate>();
  readonly dcUpgradeRetry = new Map<string, DcUpgradeRetry>();
  readonly dcBreaker: RtcDialBreaker;
  readonly dcHealth = new Map<string, AbortController>();
  dcAttemptSeq = 0;
  upgradeInflight = 0;
  readonly upgradeWaiters: Array<() => void> = [];
  upgradeScan: { clear: () => void } | null = null;
  private readonly ports: DcUpgradePorts;

  constructor(ports: DcUpgradePorts) {
    this.ports = ports;
    this.dcBreaker = createGatewayRtcDialBreaker({ now: () => this.ports.scheduler.now() });
  }

  startScan(tick: () => void): void {
    this.upgradeScan?.clear();
    this.upgradeScan = this.ports.scheduler.interval(tick, PEER_UPGRADE_SCAN_MS);
  }

  onLocalFingerprintChanged(): void {
    this.rearmAllDisabled('local-fingerprint');
  }

  onPeerEndpointChanged(nodeId: string): void {
    this.rearmDisabled(nodeId, 'peer-endpoint');
  }

  onHubSwitched(): void {
    this.rearmAllDisabled('hub-switch');
  }

  onPeerReconnected(nodeId: string): void {
    this.rearmDisabled(nodeId, 'peer-reconnect');
  }

  retryDcUpgrade(nodeId: string): void {
    this.dcBreaker.forceProbe(nodeId);
    this.cancelDcUpgradeRetry(nodeId);
    this.maybeUpgrade(nodeId, { cooldown: false });
  }

  rearmDisabled(nodeId: string, source: DcRearmSource): boolean {
    if (!this.dcBreaker.rearmDisabled(nodeId, source)) return false;
    this.cancelDcUpgradeRetry(nodeId);
    this.maybeUpgrade(nodeId, { cooldown: false });
    return true;
  }

  rearmAllDisabled(source: DcRearmSource): void {
    for (const nodeId of this.dcBreaker.disabledPeers()) {
      this.rearmDisabled(nodeId, source);
    }
  }

  clearScan(): void {
    this.upgradeScan?.clear();
    this.upgradeScan = null;
  }

  dispose(): void {
    this.clearScan();
    for (const nodeId of [...this.dcUpgradeRetry.keys()]) this.cancelDcUpgradeRetry(nodeId);
    for (const nodeId of [...this.dcHealth.keys()]) this.cancelDcHealthTimer(nodeId);
    this.dcBreaker.reset();
  }

  wantsUpgrade(live: DcUpgradeLivePeer): boolean {
    if (live.retiring) return false;
    if (live.transport === 'dc') return false;
    return (
      this.ports.shouldTryDc(live.peerNodeId) ||
      (live.transport === 'relay' && this.ports.hasWsSecureCandidate(live.peerNodeId))
    );
  }

  ensureGate(nodeId: string): UpgradeGate {
    let gate = this.upgradeGate.get(nodeId);
    if (!gate) {
      gate = { nextEligibleAt: 0, failures: 0, coalesced: false, scheduled: false };
      this.upgradeGate.set(nodeId, gate);
    }
    return gate;
  }

  noteUpgradeResult(nodeId: string, ok: boolean): void {
    const gate = this.ensureGate(nodeId);
    const now = this.ports.scheduler.now();
    if (ok) {
      gate.failures = 0;
      gate.nextEligibleAt = now + PEER_UPGRADE_COOLDOWN_MS;
      return;
    }
    gate.failures += 1;
    gate.nextEligibleAt =
      now +
      backoffDelayMs(gate.failures - 1, PEER_UPGRADE_COOLDOWN_MS, PEER_UPGRADE_BACKOFF_CAP_MS);
  }

  scheduleCoalescedUpgrade(nodeId: string): void {
    const gate = this.ensureGate(nodeId);
    if (gate.scheduled || this.ports.stopped()) return;
    gate.scheduled = true;
    const wait = Math.max(0, gate.nextEligibleAt - this.ports.scheduler.now());
    void this.ports.scheduler.sleep(wait, this.ports.stopSignal()).then(
      () => {
        gate.scheduled = false;
        if (this.ports.stopped()) return;
        if (this.ports.scheduler.now() < gate.nextEligibleAt) return;
        if (!this.upgradeGate.get(nodeId)?.coalesced) return;
        this.maybeUpgrade(nodeId, { cooldown: true });
      },
      () => {
        gate.scheduled = false;
      }
    );
  }

  acquireUpgradeSlot(): Promise<void> {
    if (this.ports.stopped()) return Promise.reject(new Error('stopped'));
    if (this.upgradeInflight < PEER_UPGRADE_MAX_INFLIGHT) {
      this.upgradeInflight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        this.ports.stopSignal().removeEventListener('abort', onAbort);
        if (this.ports.stopped()) {
          reject(new Error('stopped'));
          return;
        }
        this.upgradeInflight += 1;
        resolve();
      };
      const onAbort = () => {
        const idx = this.upgradeWaiters.indexOf(waiter);
        if (idx >= 0) this.upgradeWaiters.splice(idx, 1);
        reject(this.ports.stopSignal().reason ?? new Error('stopped'));
      };
      this.upgradeWaiters.push(waiter);
      this.ports.stopSignal().addEventListener('abort', onAbort, { once: true });
    });
  }

  releaseUpgradeSlot(): void {
    this.upgradeInflight = Math.max(0, this.upgradeInflight - 1);
    const next = this.upgradeWaiters.shift();
    next?.();
  }

  maybeUpgrade(nodeId: string, opts: { cooldown: boolean; userPath?: boolean }): void {
    if (this.ports.stopped()) return;
    if (!this.ports.isTrusted(nodeId)) return;
    const live = this.ports.live().get(nodeId);
    if (!live || !this.wantsUpgrade(live)) return;
    if (!live.quiesceCapable) {
      this.ports.probeQuiesce(live);
      this.ensureGate(nodeId).coalesced = true;
      return;
    }
    // 有在途拨号就先合并；但必须自己排一次重试，否则合并标记会一直等不到下一个触发点。
    if (this.ports.pending().has(nodeId) || this.ports.upgrading().has(nodeId)) {
      this.ensureGate(nodeId).coalesced = true;
      this.scheduleCoalescedUpgrade(nodeId);
      return;
    }
    const gate = this.ensureGate(nodeId);
    if (opts.cooldown && this.ports.scheduler.now() < gate.nextEligibleAt) {
      gate.coalesced = true;
      this.scheduleCoalescedUpgrade(nodeId);
      return;
    }
    gate.coalesced = false;
    this.queueUpgrade(nodeId);
  }

  queueUpgrade(nodeId: string): void {
    const upgrading = this.ports.upgrading();
    if (upgrading.has(nodeId)) {
      this.ensureGate(nodeId).coalesced = true;
      return;
    }
    const before = this.ports.live().get(nodeId)?.session ?? null;
    const upgrade = this.runUpgradeDial(nodeId, before);
    upgrading.set(nodeId, upgrade);
    void upgrade
      .catch(() => undefined)
      .finally(() => {
        if (upgrading.get(nodeId) === upgrade) upgrading.delete(nodeId);
        if (this.upgradeGate.get(nodeId)?.coalesced && !this.ports.stopped()) {
          this.scheduleCoalescedUpgrade(nodeId);
        }
      });
  }

  async runUpgradeDial(nodeId: string, before: LinkSession | null): Promise<LinkSession> {
    await this.acquireUpgradeSlot();
    try {
      const session = await this.ports.dialDc(nodeId);
      this.noteUpgradeResult(nodeId, session !== before);
      return session;
    } catch (err) {
      this.noteUpgradeResult(nodeId, false);
      throw err;
    } finally {
      this.releaseUpgradeSlot();
    }
  }

  cancelDcUpgradeRetry(nodeId: string): void {
    const rec = this.dcUpgradeRetry.get(nodeId);
    if (!rec) return;
    rec.abort?.abort();
    rec.abort = null;
    this.dcUpgradeRetry.delete(nodeId);
  }

  nextDcAttemptId(): string {
    this.dcAttemptSeq += 1;
    return `dc:${this.dcAttemptSeq}`;
  }

  cancelDcHealthTimer(nodeId: string): void {
    const abort = this.dcHealth.get(nodeId);
    if (!abort) return;
    this.dcHealth.delete(nodeId);
    abort.abort();
  }

  armDcHealthTimer(nodeId: string, attemptId: string): void {
    this.cancelDcHealthTimer(nodeId);
    const abort = new AbortController();
    this.dcHealth.set(nodeId, abort);
    const establishedAt = this.ports.scheduler.now();
    const handle = this.ports.scheduler.interval(() => {
      handle.clear();
      if (this.dcHealth.get(nodeId) !== abort) return;
      this.dcHealth.delete(nodeId);
      if (this.ports.scheduler.now() - establishedAt < RTC_DIAL_BREAKER_HEALTHY_MS) return;
      const live = this.ports.live().get(nodeId);
      if (live?.transport !== 'dc' || live.dcAttemptId !== attemptId) return;
      if (this.dcBreaker.noteHealthy(nodeId)) this.ports.emitLinkInfo(live);
    }, RTC_DIAL_BREAKER_HEALTHY_MS);
    abort.signal.addEventListener(
      'abort',
      () => {
        handle.clear();
        if (this.dcHealth.get(nodeId) === abort) this.dcHealth.delete(nodeId);
      },
      { once: true }
    );
  }

  dcUpgradeRetryDelayMs(attempt: number): number {
    return attempt < PEER_DC_UPGRADE_RETRY_DELAYS_MS.length
      ? PEER_DC_UPGRADE_RETRY_DELAYS_MS[attempt]
      : PEER_DC_UPGRADE_RETRY_TAIL_MS;
  }

  armDcUpgradeRetry(nodeId: string): void {
    const live = this.liveForDcRetry(nodeId);
    if (!live) return;
    const decision = this.dcBreaker.shouldTry(nodeId);
    if (decision.disabled && !decision.allow) {
      this.scheduleDcBreakerProbe(nodeId, this.ports.scheduler.now() + RTC_DIAL_FORCE_PROBE_MS);
      return;
    }
    if (!decision.allow) {
      this.scheduleDcBreakerProbe(nodeId, decision.until);
      return;
    }
    if (!live.quiesceCapable) return;
    let rec = this.dcUpgradeRetry.get(nodeId);
    if (!rec) {
      rec = { attempt: 0, abort: null };
      this.dcUpgradeRetry.set(nodeId, rec);
    }
    if (rec.abort) return;
    const inMs = this.dcUpgradeRetryDelayMs(rec.attempt);
    const attempt = rec.attempt + 1;
    this.ports.log('upgrade retry', { peer: nodeId, attempt, in_ms: inMs });
    const abort = new AbortController();
    rec.abort = abort;
    const onStop = () => abort.abort();
    this.ports.stopSignal().addEventListener('abort', onStop, { once: true });
    void this.ports.scheduler.sleep(inMs, abort.signal).then(
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
        rec.attempt = attempt;
        if (!this.liveForDcRetry(nodeId)) return;
        if (!this.ports.shouldTryDc(nodeId)) {
          this.armDcUpgradeRetry(nodeId);
          return;
        }
        this.maybeUpgrade(nodeId, { cooldown: true });
        const pending = this.ports.upgrading().get(nodeId) ?? this.ports.pending().get(nodeId);
        if (pending) {
          void pending
            .finally(() => {
              if (this.ports.live().get(nodeId)?.transport === 'dc') {
                this.ports.lostDirect().delete(nodeId);
                this.cancelDcUpgradeRetry(nodeId);
                return;
              }
              this.armDcUpgradeRetry(nodeId);
            })
            .catch(() => undefined);
        } else {
          this.armDcUpgradeRetry(nodeId);
        }
      },
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
      }
    );
  }

  scheduleDcBreakerProbe(nodeId: string, until: number | null): void {
    const live = this.liveForDcRetry(nodeId);
    if (!live) return;
    if (!live.quiesceCapable) return;
    let rec = this.dcUpgradeRetry.get(nodeId);
    if (!rec) {
      rec = { attempt: 0, abort: null };
      this.dcUpgradeRetry.set(nodeId, rec);
    }
    if (rec.abort) return;
    const inMs = Math.max(0, (until ?? this.ports.scheduler.now()) - this.ports.scheduler.now());
    this.ports.log('upgrade retry', {
      peer: nodeId,
      attempt: rec.attempt + 1,
      in_ms: inMs,
      cause: this.dcBreaker.isDisabled(nodeId) ? 'breaker_disabled' : 'breaker_cooling',
    });
    const abort = new AbortController();
    rec.abort = abort;
    const onStop = () => abort.abort();
    this.ports.stopSignal().addEventListener('abort', onStop, { once: true });
    void this.ports.scheduler.sleep(inMs, abort.signal).then(
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
        if (!this.liveForDcRetry(nodeId)) return;
        if (!this.ports.shouldTryDc(nodeId)) {
          const next = this.dcBreaker.shouldTry(nodeId);
          if (next.disabled) {
            this.scheduleDcBreakerProbe(
              nodeId,
              this.ports.scheduler.now() + RTC_DIAL_FORCE_PROBE_MS
            );
            return;
          }
          if (next.cooling) this.scheduleDcBreakerProbe(nodeId, next.until);
          return;
        }
        this.maybeUpgrade(nodeId, { cooldown: true });
        const pending = this.ports.upgrading().get(nodeId) ?? this.ports.pending().get(nodeId);
        if (pending) {
          void pending
            .finally(() => {
              if (this.ports.live().get(nodeId)?.transport === 'dc') {
                this.ports.lostDirect().delete(nodeId);
                this.cancelDcUpgradeRetry(nodeId);
                return;
              }
              this.armDcUpgradeRetry(nodeId);
            })
            .catch(() => undefined);
        } else {
          this.armDcUpgradeRetry(nodeId);
        }
      },
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
      }
    );
  }

  private liveForDcRetry(nodeId: string): DcUpgradeLivePeer | null {
    if (this.ports.stopped()) {
      this.cancelDcUpgradeRetry(nodeId);
      return null;
    }
    if (!this.ports.dcCapable(nodeId)) {
      this.ports.lostDirect().delete(nodeId);
      this.cancelDcUpgradeRetry(nodeId);
      return null;
    }
    const live = this.ports.live().get(nodeId);
    if (!live || live.retiring) {
      this.cancelDcUpgradeRetry(nodeId);
      return null;
    }
    if (live.transport === 'dc') {
      this.ports.lostDirect().delete(nodeId);
      this.cancelDcUpgradeRetry(nodeId);
      return null;
    }
    return live;
  }
}

export function sanitizeEndpoints(value: unknown, fallbackPort?: number): string[] {
  if (typeof value === 'string') return parseEndpoints(value, fallbackPort);
  try {
    return parseEndpoints(JSON.stringify(value ?? []), fallbackPort);
  } catch {
    return [];
  }
}

export function parseEndpoints(endpointsJson: string, fallbackPort?: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(endpointsJson);
  } catch {
    return [];
  }
  const urls: string[] = [];
  const push = (raw: string) => {
    if (urls.length >= PEER_MAX_ENDPOINTS) return;
    if (raw.length > PEER_MAX_ENDPOINT_LENGTH) return;
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
      urls.push(raw);
      return;
    }
    if (raw.includes('://')) return;
    const withPath = raw.includes('/peer') ? raw : `${raw}/peer`;
    const url = withPath.startsWith('ws') ? withPath : `ws://${withPath}`;
    if (url.length > PEER_MAX_ENDPOINT_LENGTH) return;
    urls.push(url);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string') {
        push(item);
      } else if (isRecord(item)) {
        if (typeof item.url === 'string') push(item.url);
        else if (typeof item.host === 'string') {
          const port = typeof item.port === 'number' ? item.port : (fallbackPort ?? 39001);
          const path = typeof item.path === 'string' ? item.path : '/peer';
          push(`ws://${item.host}:${port}${path.startsWith('/') ? path : `/${path}`}`);
        }
      }
    }
  }
  return urls;
}

export abstract class PeerCollaboratorHost {
  protected abstract readonly dcUpgrade: DcUpgradeCoordinator;
  protected abstract readonly rtcWake: RtcWakeGate;

  protected wantsUpgrade(live: DcUpgradeLivePeer): boolean {
    return this.dcUpgrade.wantsUpgrade(live);
  }
  protected ensureGate(nodeId: string): UpgradeGate {
    return this.dcUpgrade.ensureGate(nodeId);
  }
  protected noteUpgradeResult(nodeId: string, ok: boolean): void {
    this.dcUpgrade.noteUpgradeResult(nodeId, ok);
  }
  protected scheduleCoalescedUpgrade(nodeId: string): void {
    this.dcUpgrade.scheduleCoalescedUpgrade(nodeId);
  }
  protected acquireUpgradeSlot(): Promise<void> {
    return this.dcUpgrade.acquireUpgradeSlot();
  }
  protected releaseUpgradeSlot(): void {
    this.dcUpgrade.releaseUpgradeSlot();
  }
  protected queueUpgrade(nodeId: string): void {
    this.dcUpgrade.queueUpgrade(nodeId);
  }
  protected runUpgradeDial(nodeId: string, before: LinkSession | null): Promise<LinkSession> {
    return this.dcUpgrade.runUpgradeDial(nodeId, before);
  }
  protected maybeUpgrade(nodeId: string, opts: { cooldown: boolean; userPath?: boolean }): void {
    this.dcUpgrade.maybeUpgrade(nodeId, opts);
  }
  protected handleIncomingRtcWake(fromNodeId: string, msg: RtcSignalMessage): void {
    this.rtcWake.handleIncomingRtcWake(fromNodeId, msg);
  }
  protected ensureIncomingWakeGate(fromNodeId: string): IncomingWakeGate {
    return this.rtcWake.ensureIncomingWakeGate(fromNodeId);
  }
  protected cancelDcUpgradeRetry(nodeId: string): void {
    this.dcUpgrade.cancelDcUpgradeRetry(nodeId);
  }
  protected nextDcAttemptId(): string {
    return this.dcUpgrade.nextDcAttemptId();
  }
  protected cancelDcHealthTimer(nodeId: string): void {
    this.dcUpgrade.cancelDcHealthTimer(nodeId);
  }
  protected armDcHealthTimer(nodeId: string, attemptId: string): void {
    this.dcUpgrade.armDcHealthTimer(nodeId, attemptId);
  }
  protected armDcUpgradeRetry(nodeId: string): void {
    this.dcUpgrade.armDcUpgradeRetry(nodeId);
  }
  protected releaseRtcWakeAttempt(peerNodeId: string): void {
    this.rtcWake.releaseRtcWakeAttempt(peerNodeId);
  }
  protected dispatchRtcWake(peerNodeId: string): void {
    this.rtcWake.dispatchRtcWake(peerNodeId);
  }
  protected signalingFor(peerNodeId: string): RtcSignaling {
    return this.rtcWake.signalingFor(peerNodeId);
  }
  protected sendRtcSignal(peerNodeId: string, msg: RtcSignalMessage): void {
    this.rtcWake.sendRtcSignal(peerNodeId, msg);
  }
  protected acceptSignedRtcWake(
    fromNodeId: string,
    msg: RtcSignalMessage,
    wake: RtcWakeFields
  ): boolean {
    return this.rtcWake.acceptSignedRtcWake(fromNodeId, msg, wake);
  }
  protected rememberRtcWakeNonce(fromNodeId: string, nonce: string, issuedAt: number): boolean {
    return this.rtcWake.rememberRtcWakeNonce(fromNodeId, nonce, issuedAt);
  }
  protected pruneRtcWakeNonces(peer: Map<string, number>): void {
    this.rtcWake.pruneRtcWakeNonces(peer);
  }
  protected consumeWakeVerifyToken(gate: IncomingWakeGate, now: number): boolean {
    return this.rtcWake.consumeWakeVerifyToken(gate, now);
  }
  protected dcUpgradeRetryDelayMs(attempt: number): number {
    return this.dcUpgrade.dcUpgradeRetryDelayMs(attempt);
  }
  protected ensureWakeGate(peerNodeId: string): WakeGate {
    return this.rtcWake.ensureWakeGate(peerNodeId);
  }
  protected abortDeferredRtcWakes(): void {
    this.rtcWake.abortDeferredRtcWakes();
  }
  protected disarmDeferredRtcWake(gate: WakeGate): void {
    this.rtcWake.disarmDeferredRtcWake(gate);
  }
  protected armDeferredRtcWake(peerNodeId: string, gate: WakeGate): void {
    this.rtcWake.armDeferredRtcWake(peerNodeId, gate);
  }
}
