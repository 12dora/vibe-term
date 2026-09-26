import { compareSemver } from '@vibeterm/shared';
import type { LinkSession } from '@vibeterm/shared/link';
import { backoffDelayMs } from './ctl';
import { isNodePaused } from './node-pause';
import {
  attachPermanentHoldClear,
  backgroundUpgradeSkipsDc,
  isBackgroundDcUpgradeBlocked,
  noteBackgroundDcUpgradeAttempt,
} from './peer-dc-upgrade-gate';
import { RelayPresenceGap } from './peer-reconnect-wake';
import {
  type DcRearmSource,
  type RtcDialBreaker,
  createGatewayRtcDialBreaker,
} from './rtc/rtc-dial-breaker';
import { forceProbeJitterMs } from './rtc/rtc-force-probe';
import type { MeshScheduler, PeerTransportKind } from './types';
export const PEER_UPGRADE_COOLDOWN_MS = 10_000;
export const PEER_UPGRADE_SCAN_MS = 15_000;
export const PEER_UPGRADE_BACKOFF_CAP_MS = 5 * 60 * 1000;
export const PEER_UPGRADE_MAX_INFLIGHT = 4;
export const PEER_DC_UPGRADE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
export const PEER_DC_UPGRADE_RETRY_TAIL_MS = 120_000;
export {
  PEER_MAX_ENDPOINT_LENGTH,
  PEER_MAX_ENDPOINTS,
  parseEndpoints,
  sanitizeEndpoints,
} from './peer-endpoint-parse';

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
  linkSinceAt?: number;
};

export type DcUpgradePorts = {
  scheduler: MeshScheduler;
  live: () => Map<string, DcUpgradeLivePeer>;
  dialDc: (nodeId: string, opts?: { skipDc?: boolean }) => Promise<LinkSession>;
  shouldTryDc: (nodeId: string) => boolean;
  dcCapable: (nodeId: string) => boolean;
  emitLinkInfo: (live: DcUpgradeLivePeer) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  stopped: () => boolean;
  stopSignal: () => AbortSignal;
  isTrusted: (nodeId: string) => boolean;
  pending: () => Map<string, Promise<LinkSession>>;
  upgrading: () => Map<string, Promise<LinkSession>>;
  hasDcInflight: (nodeId: string) => boolean;
  probeQuiesce: (live: DcUpgradeLivePeer) => void;
  hasWsSecureCandidate: (nodeId: string) => boolean;
  lostDirect: () => Set<string>;
  clearUnstableStreak?: (nodeId?: string) => void;
  canDialDirect?: (nodeId: string, opts: { peerInitiated: boolean }) => boolean;
  allowsUpgrade?: (nodeId: string) => boolean;
  peerCapability?: (nodeId: string) => { version: string | null; directCapable: boolean } | null;
  dcProven?: (nodeId: string) => boolean;
};

export class DcUpgradeCoordinator {
  readonly upgradeGate = new Map<string, UpgradeGate>();
  readonly dcUpgradeRetry = new Map<string, DcUpgradeRetry>();
  readonly dcBreaker: RtcDialBreaker;
  dcAttemptSeq = 0;
  upgradeInflight = 0;
  readonly upgradeWaiters: Array<() => void> = [];
  upgradeScan: { clear: () => void } | null = null;
  private readonly wsUpgradeInflight = new Set<string>();
  private readonly presenceGap = new RelayPresenceGap();
  private readonly ports: DcUpgradePorts;
  private readonly capSnap = new Map<
    string,
    { version: string | null; directCapable: boolean; at: number }
  >();

  constructor(ports: DcUpgradePorts) {
    this.ports = ports;
    this.dcBreaker = attachPermanentHoldClear(
      createGatewayRtcDialBreaker({
        now: () => this.ports.scheduler.now(),
      }),
      () => this.ports.scheduler.now()
    );
  }

  startScan(tick: () => void): void {
    this.upgradeScan?.clear();
    this.upgradeScan = this.ports.scheduler.interval(tick, PEER_UPGRADE_SCAN_MS);
  }

  onLocalFingerprintChanged(): void {
    this.ports.clearUnstableStreak?.();
    this.upgradeClearedSoft();
    this.rearmAllDisabled('local-fingerprint');
  }

  onPeerEndpointChanged(nodeId: string): void {
    this.ports.clearUnstableStreak?.(nodeId);
    this.rearmDisabled(nodeId, 'peer-endpoint');
  }

  onUplinkSwitched(): void {
    this.ports.clearUnstableStreak?.();
    this.upgradeClearedSoft();
    this.decayEscalated('uplink-url-changed');
  }

  onIceConfigChanged(): void {
    this.decayEscalated('ice-config');
  }

  /** relay/ws 会话替换不是 DC 会通的证据，不 rearm、不降档。 */
  onPeerReconnected(_nodeId: string): void {}

  onPeerCapabilitiesChanged(nodeId: string): void {
    const next = this.ports.peerCapability?.(nodeId);
    if (!next) {
      this.ports.clearUnstableStreak?.(nodeId);
      this.rearmDisabled(nodeId, 'peer-capabilities');
      return;
    }
    const now = this.ports.scheduler.now();
    const prev = this.capSnap.get(nodeId);
    if (!prev) {
      this.capSnap.set(nodeId, {
        version: next.version,
        directCapable: next.directCapable,
        at: now,
      });
      this.ports.clearUnstableStreak?.(nodeId);
      this.rearmDisabled(nodeId, 'peer-capabilities');
      return;
    }
    const versionUp = capabilityVersionIncreased(prev.version, next.version);
    const capableEdge = !prev.directCapable && next.directCapable;
    if (!versionUp && !capableEdge) {
      this.capSnap.set(nodeId, {
        version: next.version,
        directCapable: next.directCapable,
        at: prev.at,
      });
      return;
    }
    if (now - prev.at < CAPABILITY_REARM_DEBOUNCE_MS) return;
    this.capSnap.set(nodeId, { version: next.version, directCapable: next.directCapable, at: now });
    this.ports.clearUnstableStreak?.(nodeId);
    this.rearmDisabled(nodeId, 'peer-capabilities');
  }

  noteRelayPresence(nodeId: string, online: boolean): boolean {
    const event = this.presenceGap.observe(nodeId, online, this.ports.scheduler.now());
    if (event !== 'returned') return false;
    return this.rearmDisabled(nodeId, 'presence-return');
  }

  retryDcUpgrade(nodeId: string): void {
    this.ports.clearUnstableStreak?.(nodeId);
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
    this.presenceGap.reset();
    this.capSnap.clear();
    this.dcBreaker.reset();
  }

  wantsUpgrade(live: DcUpgradeLivePeer): boolean {
    if (live.retiring || isNodePaused(live.peerNodeId)) return false;
    if (live.transport === 'dc') return false;
    if (this.ports.allowsUpgrade && !this.ports.allowsUpgrade(live.peerNodeId)) return false;
    if (this.wsSecureCandidate(live)) return true;
    if (this.dcBreaker.honoursRemoteRefusal(live.peerNodeId)) return false;
    if (!this.ports.dcCapable(live.peerNodeId)) return false;
    if (isBackgroundDcUpgradeBlocked(this.dcBreaker, live.peerNodeId, this.ports.scheduler.now())) {
      return false;
    }
    return this.ports.shouldTryDc(live.peerNodeId);
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
    const wsSecure = live.transport === 'relay' && this.ports.hasWsSecureCandidate(nodeId);
    if (
      !(wsSecure && !this.wsUpgradeInflight.has(nodeId)) &&
      (this.ports.pending().has(nodeId) ||
        this.ports.upgrading().has(nodeId) ||
        this.ports.hasDcInflight(nodeId))
    ) {
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
    const liveNow = this.ports.live().get(nodeId);
    const wsSecure = liveNow != null && this.wsSecureCandidate(liveNow);
    const skipDc = backgroundUpgradeSkipsDc(
      this.dcLegBlocked(nodeId),
      isBackgroundDcUpgradeBlocked(this.dcBreaker, nodeId, this.ports.scheduler.now())
    );
    if (!wsSecure && skipDc) return;
    if (!skipDc) noteBackgroundDcUpgradeAttempt(this.dcBreaker, nodeId, this.ports.scheduler.now());
    const upgrading = this.ports.upgrading();
    const live = liveNow;
    if (upgrading.has(nodeId) && (!wsSecure || this.wsUpgradeInflight.has(nodeId))) {
      this.ensureGate(nodeId).coalesced = true;
      return;
    }
    const before = live?.session ?? null;
    const upgrade = this.runUpgradeDial(nodeId, before, skipDc);
    if (wsSecure) this.wsUpgradeInflight.add(nodeId);
    upgrading.set(nodeId, upgrade);
    void upgrade
      .catch(() => undefined)
      .finally(() => {
        this.wsUpgradeInflight.delete(nodeId);
        if (upgrading.get(nodeId) === upgrade) upgrading.delete(nodeId);
        if (this.upgradeGate.get(nodeId)?.coalesced && !this.ports.stopped()) {
          this.scheduleCoalescedUpgrade(nodeId);
        }
      });
  }

  async runUpgradeDial(nodeId: string, before: LinkSession | null, skipDc = false) {
    await this.acquireUpgradeSlot();
    try {
      const session = await this.ports.dialDc(nodeId, skipDc ? { skipDc: true } : undefined);
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

  cancelDcHealthTimer(_nodeId: string): void {}

  armDcHealthTimer(_nodeId: string, _attemptId: string): void {}

  scanPeers(): void {
    this.noteLiveDcHealth();
    for (const nodeId of this.ports.live().keys()) {
      this.maybeUpgrade(nodeId, { cooldown: true });
    }
  }

  noteLiveDcHealth(): void {
    const now = this.ports.scheduler.now();
    for (const live of this.ports.live().values()) {
      if (live.transport !== 'dc' || live.retiring || live.linkSinceAt == null) continue;
      const proven = this.ports.dcProven?.(live.peerNodeId) === true;
      const ageMs = now - live.linkSinceAt;
      if (this.dcBreaker.noteHealthy(live.peerNodeId, now, { ageMs, proven })) {
        this.ports.emitLinkInfo(live);
      }
    }
  }

  dcUpgradeRetryDelayMs(attempt: number): number {
    return attempt < PEER_DC_UPGRADE_RETRY_DELAYS_MS.length
      ? PEER_DC_UPGRADE_RETRY_DELAYS_MS[attempt]
      : PEER_DC_UPGRADE_RETRY_TAIL_MS;
  }

  armDcUpgradeRetry(nodeId: string): void {
    if (this.dcBreaker.isDisabled(nodeId)) {
      this.scheduleDisabledProbe(nodeId);
      return;
    }
    const live = this.liveForDcRetry(nodeId);
    if (!live) return;
    const decision = this.dcBreaker.shouldTry(nodeId);
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
        this.followUpgradeRetry(nodeId);
      },
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
      }
    );
  }

  scheduleDcBreakerProbe(nodeId: string, until: number | null, ignoreQuiesce = false): void {
    const live = this.liveForDcRetry(nodeId);
    if (!live) return;
    if (!ignoreQuiesce && !live.quiesceCapable) return;
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
        this.onBreakerProbeFired(nodeId);
      },
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
      }
    );
  }

  /** 已 coalesced/scheduled 且 wantsUpgrade、未冷却、非 lost-direct。熔断健康不算。 */
  willAttemptUpgrade(nodeId: string): boolean {
    const live = this.ports.live().get(nodeId);
    if (!live || !this.wantsUpgrade(live) || this.ports.lostDirect().has(nodeId)) return false;
    if (!live.quiesceCapable) return false;
    const gate = this.upgradeGate.get(nodeId);
    if (gate && this.ports.scheduler.now() < gate.nextEligibleAt) return false;
    return gate?.scheduled === true || gate?.coalesced === true;
  }

  private followUpgradeRetry(nodeId: string): void {
    this.maybeUpgrade(nodeId, { cooldown: true });
    const pending = this.ports.upgrading().get(nodeId) ?? this.ports.pending().get(nodeId);
    if (!pending) {
      this.armDcUpgradeRetry(nodeId);
      return;
    }
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
  }

  private scheduleDisabledProbe(nodeId: string): void {
    const live = this.ports.live().get(nodeId);
    if (!this.dcBreaker.isDisabled(nodeId) || !live || live.retiring || live.transport === 'dc') {
      return;
    }
    if (!live.quiesceCapable) {
      this.ports.probeQuiesce(live);
      this.ensureGate(nodeId).coalesced = true;
    }
    const at = this.dcBreaker.nextOutboundProbeAt(nodeId);
    if (at == null) return;
    this.scheduleDcBreakerProbe(nodeId, at, true);
  }

  private onBreakerProbeFired(nodeId: string): void {
    if (!this.ports.dcCapable(nodeId)) {
      this.cancelDcUpgradeRetry(nodeId);
      return;
    }
    if (!this.liveForDcRetry(nodeId)) return;
    const live = this.ports.live().get(nodeId);
    if (this.dcBreaker.isDisabled(nodeId) && live && !live.quiesceCapable) {
      this.ports.probeQuiesce(live);
      this.ensureGate(nodeId).coalesced = true;
      const wait = this.dcBreaker.disabledProbeIntervalMs(nodeId);
      this.scheduleDcBreakerProbe(nodeId, this.ports.scheduler.now() + wait, true);
      return;
    }
    if (!this.ports.shouldTryDc(nodeId)) {
      this.rescheduleBlockedProbe(nodeId);
      return;
    }
    this.followUpgradeRetry(nodeId);
  }

  private rescheduleBlockedProbe(nodeId: string): void {
    const next = this.dcBreaker.shouldTry(nodeId);
    if (next.disabled) {
      this.scheduleDisabledProbe(nodeId);
      return;
    }
    if (next.cooling) this.scheduleDcBreakerProbe(nodeId, next.until);
  }

  private decayEscalated(source: DcRearmSource): void {
    for (const peer of this.dcBreaker.escalatedPeers()) {
      if (!this.dcBreaker.rearmDisabled(peer, source)) continue;
      const jitter = forceProbeJitterMs(peer, 60_000);
      this.scheduleUpgrade(peer, jitter);
    }
  }

  private scheduleUpgrade(nodeId: string, delayMs: number): void {
    void this.ports.scheduler.sleep(delayMs, this.ports.stopSignal()).then(
      () => {
        if (this.ports.stopped()) return;
        this.maybeUpgrade(nodeId, { cooldown: false });
      },
      () => undefined
    );
  }

  private upgradeClearedSoft(): void {
    for (const nodeId of this.dcBreaker.clearUnstableCooldowns()) {
      this.scheduleUpgrade(nodeId, forceProbeJitterMs(nodeId, 60_000));
    }
  }

  private wsSecureCandidate(live: DcUpgradeLivePeer): boolean {
    return live.transport === 'relay' && this.ports.hasWsSecureCandidate(live.peerNodeId);
  }
  private dcLegBlocked(nodeId: string): boolean {
    if (this.ports.canDialDirect && !this.ports.canDialDirect(nodeId, { peerInitiated: false })) {
      return true;
    }
    return !this.ports.shouldTryDc(nodeId);
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

const CAPABILITY_REARM_DEBOUNCE_MS = 5_000;

function capabilityVersionIncreased(prev: string | null, next: string | null): boolean {
  return Boolean(prev && next && (compareSemver(next, prev) ?? 0) > 0);
}
