import type { LinkSession } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { logLine } from './mesh-log';
import { markLiveDcProven } from './peer-dc-proof';
import {
  PEER_PING_INTERVAL_MS,
  measurePingRttMs,
  missedPongExceeded,
  parseEchoedSentAt,
} from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import { signalRoutePromoted } from './pending-measure-hold';
import { adoptSessionRtcUnsub, closeRouteSession, releaseHeldRtcUnsub } from './route-decline';
import type { TrackIntercept, TrackInterceptInput } from './route-degrade';
import type { PeerRouteRecord } from './route-degrade-record';
import { formatRouteSwitch } from './route-degrade-record';
import {
  ROUTE_PROMOTE_SAMPLES,
  dcPromoteAdditiveMs,
  dcPromoteBackoffMs,
  dcPromoteMeasureTimeoutMs,
  dcPromoteRatio,
  dcPromoteTooSlow,
  isDirectTransport,
  shouldPromoteDirect,
} from './route-policy';
import { currentDcProofGeneration, markDcLinkProof } from './rtc/dc-link-proof';
import { claimSession, rememberInstallMeta, touchSession } from './session-binding';
import type { MeshScheduler, PeerTransportKind } from './types';

export type HoldKind = 'degraded' | 'promote' | 'reroll';

export type CandidateOffer = {
  session: LinkSession;
  peerNodeId: string;
  transport: 'dc' | 'ws-secure';
  initiatedBy: string;
  gen: number;
  remoteAddress?: string | null;
  dcAttemptId?: string | null;
  rtcEpoch?: number;
  quiesceCapable?: boolean;
};

export type HoldHost = {
  now(): number;
  selfId(): string;
  mode(): string;
  isDegraded(peerId: string): boolean;
  allowsInboundDirect(): boolean;
  scheduler: MeshScheduler;
  live(peerId: string): LivePeer | undefined;
  relayMs(peerId: string, live: LivePeer | undefined): number | null;
  recordOf(peerId: string): PeerRouteRecord;
  resetPeer(peerId: string): void;
  armDegradedBackoff(peerId: string): void;
  watchMeasure(session: LinkSession, peerId: string): void;
  forceInstall(
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress?: string | null,
    dcAttemptId?: string | null,
    rtcEpoch?: number
  ): LinkSession | null;
  finishRetire(live: LivePeer, reason: string): void;
};

type DirectCandidate = {
  session: LinkSession;
  peerId: string;
  transport: 'dc' | 'ws-secure';
  initiatedBy: string;
  gen: number;
  remoteAddress: string | null;
  dcAttemptId: string | null;
  rtcEpoch?: number;
  quiesceCapable: boolean;
  kind: HoldKind;
  missedPongs: number;
  samples: number[];
  samplesNeeded: number;
  queueStreams: boolean;
  fromTransport: string;
  baselineRelayMs: number | null;
  pingTimer: { clear: () => void } | null;
  pingSentAt: number | null;
  abort: AbortController | null;
};

export class CandidateHold {
  private readonly candidates = new Map<string, DirectCandidate>();

  constructor(private readonly host: HoldHost) {}

  has(peerId: string): boolean {
    return this.candidates.has(peerId);
  }

  ids(): string[] {
    return [...this.candidates.keys()];
  }

  dispose(): void {
    for (const peerId of [...this.candidates.keys()]) this.drop(peerId, 'stopped');
  }

  intercept(input: TrackInterceptInput): TrackIntercept {
    if (!isDirectTransport(input.transport)) return { action: 'continue' };
    touchSession(input.session);
    this.host.watchMeasure(input.session, input.peerNodeId);
    if (!this.host.allowsInboundDirect()) return { action: 'reject', reason: 'route-relay' };
    if (this.host.mode() !== 'auto') return { action: 'continue' };
    const kind = this.kindForTrack(input);
    if (kind === 'continue') return { action: 'continue' };
    if (kind === 'backoff') return { action: 'reject', reason: 'dc-promote-backoff' };
    this.hold(input, kind);
    return { action: 'hold' };
  }

  offer(input: CandidateOffer): 'held' | 'installed' | 'rejected' {
    rememberOfferMeta(input);
    touchSession(input.session);
    this.host.watchMeasure(input.session, input.peerNodeId);
    if (!this.host.allowsInboundDirect()) {
      this.end(input.session, input.peerNodeId, 'route-relay', input.rtcEpoch);
      return 'rejected';
    }
    const live = this.host.live(input.peerNodeId);
    if (!live || live.session === input.session) return this.installNow(input);
    const kind = this.kindForOffer(live);
    if (kind === 'install') return this.installNow(input);
    if (kind === 'reject' || kind === 'backoff') {
      const reason = kind === 'backoff' ? 'dc-promote-backoff' : 'route-measure-reject';
      this.end(input.session, input.peerNodeId, reason, input.rtcEpoch);
      return 'rejected';
    }
    this.hold(offerAsTrack(input, live), kind);
    return 'held';
  }

  noteSample(peerId: string, sampleMs: number): void {
    const candidate = this.candidates.get(peerId);
    if (!candidate) return;
    candidate.samples.push(Math.max(0, Math.round(sampleMs)));
    if (candidate.samples.length < candidate.samplesNeeded) return;
    this.finish(candidate, Math.max(...candidate.samples));
  }

  drop(peerId: string, reason: string): void {
    const candidate = this.candidates.get(peerId);
    if (!candidate) return;
    this.stop(candidate);
    this.candidates.delete(peerId);
    this.end(candidate.session, peerId, reason, candidate.rtcEpoch);
  }

  /** live 掉了、或模式切到 direct：立刻装上持有的候选。 */
  promoteNow(peerId: string): void {
    const candidate = this.candidates.get(peerId);
    if (!candidate) return;
    this.stop(candidate);
    this.candidates.delete(peerId);
    this.accept(candidate, this.host.live(peerId), null, candidate.baselineRelayMs);
  }

  private kindForTrack(input: TrackInterceptInput): HoldKind | 'continue' | 'backoff' {
    const prev = input.prev;
    if (this.host.isDegraded(input.peerNodeId) && prev?.transport === 'relay') return 'degraded';
    if (this.host.isDegraded(input.peerNodeId)) return 'continue';
    if (input.transport !== 'dc') return 'continue';
    if (!prev || prev.session === input.session || prev.transport === 'dc') return 'continue';
    if (prev.rttMs == null) return 'continue';
    if (this.cooling(input.peerNodeId)) return 'backoff';
    return 'promote';
  }

  private kindForOffer(live: LivePeer): HoldKind | 'install' | 'reject' | 'backoff' {
    if (this.host.mode() !== 'auto') return 'install';
    if (this.host.isDegraded(live.peerNodeId) && live.transport === 'relay') return 'degraded';
    if (live.transport === 'dc' || live.transport === 'ws-secure') {
      return live.rttMs == null ? 'install' : 'reroll';
    }
    if (live.rttMs == null) return 'install';
    if (this.cooling(live.peerNodeId)) return 'backoff';
    return 'promote';
  }

  private cooling(peerId: string): boolean {
    return this.host.now() < this.host.recordOf(peerId).promoteBackoffUntil;
  }

  private hold(input: TrackInterceptInput, kind: HoldKind): void {
    if (!isDirectTransport(input.transport)) return;
    this.drop(input.peerNodeId, 'replaced-candidate');
    const candidate = this.create(input, kind);
    this.candidates.set(input.peerNodeId, candidate);
    claimSession(input.session, {
      role: 'candidate',
      peerId: input.peerNodeId,
      owner: candidate,
      queueStreams: candidate.queueStreams,
      onCtl: (bytes) => this.onPong(candidate, bytes),
    });
    this.armPing(candidate);
    void input.session.closed.then(() => this.onClosed(candidate));
  }

  private create(input: TrackInterceptInput, kind: HoldKind): DirectCandidate {
    const queue = kind !== 'degraded';
    return {
      session: input.session,
      peerId: input.peerNodeId,
      transport: isDirectTransport(input.transport) ? input.transport : 'dc',
      initiatedBy: input.initiatedBy,
      gen: input.gen,
      remoteAddress: input.remoteAddress,
      dcAttemptId: input.dcAttemptId,
      rtcEpoch: input.rtcEpoch,
      quiesceCapable: input.quiesceCapable === true,
      kind,
      missedPongs: 0,
      samples: [],
      samplesNeeded: kind === 'degraded' ? ROUTE_PROMOTE_SAMPLES : 1,
      queueStreams: queue,
      fromTransport: input.prev?.transport ?? 'relay',
      baselineRelayMs: this.baseline(input, kind),
      pingTimer: null,
      pingSentAt: null,
      abort: null,
    };
  }

  private baseline(input: TrackInterceptInput, kind: HoldKind): number | null {
    if (kind === 'degraded') return this.host.relayMs(input.peerNodeId, input.prev);
    return input.prev?.rttMs ?? null;
  }

  private armPing(candidate: DirectCandidate): void {
    const send = () => this.sendPing(candidate);
    send();
    if (candidate.kind === 'degraded') {
      candidate.pingTimer = this.host.scheduler.interval(send, PEER_PING_INTERVAL_MS);
      return;
    }
    const abort = new AbortController();
    candidate.abort = abort;
    void this.host.scheduler.sleep(dcPromoteMeasureTimeoutMs(), abort.signal).then(
      () => {
        if (this.candidates.get(candidate.peerId) !== candidate) return;
        if (candidate.samples.length > 0) return;
        this.finish(candidate, null);
      },
      () => undefined
    );
  }

  private sendPing(candidate: DirectCandidate): void {
    if (this.candidates.get(candidate.peerId) !== candidate) return;
    if (candidate.kind === 'degraded' && missedPongExceeded(candidate.missedPongs, null)) {
      this.drop(candidate.peerId, 'missed-pong');
      return;
    }
    if (candidate.kind === 'degraded') candidate.missedPongs += 1;
    candidate.pingSentAt = performance.now();
    quiet(() =>
      candidate.session.ctl.send(encodeJsonBytes({ t: 'ping', sentAt: candidate.pingSentAt }))
    );
  }

  private onPong(candidate: DirectCandidate, bytes: Uint8Array): void {
    if (this.candidates.get(candidate.peerId) !== candidate) return;
    const msg = parseOpenPayload(bytes);
    if (!msg || msg.t !== 'pong') return;
    const sample = measurePingRttMs(
      performance.now(),
      parseEchoedSentAt(msg.sentAt),
      candidate.pingSentAt
    );
    candidate.pingSentAt = null;
    candidate.missedPongs = 0;
    if (sample == null) return;
    this.noteSample(candidate.peerId, sample);
  }

  private onClosed(candidate: DirectCandidate): void {
    if (this.candidates.get(candidate.peerId) !== candidate) return;
    this.stop(candidate);
    this.candidates.delete(candidate.peerId);
    releaseHeldRtcUnsub(candidate.session);
  }

  private finish(candidate: DirectCandidate, directMs: number | null): void {
    if (this.candidates.get(candidate.peerId) !== candidate) return;
    this.stop(candidate);
    this.candidates.delete(candidate.peerId);
    const live = this.host.live(candidate.peerId);
    const relayMs = this.relayForSettle(candidate, live);
    if (!this.passes(candidate, directMs, relayMs)) {
      this.reject(candidate, directMs, relayMs);
      return;
    }
    this.accept(candidate, live, directMs, relayMs);
  }

  private relayForSettle(candidate: DirectCandidate, live: LivePeer | undefined): number | null {
    if (candidate.kind !== 'degraded') {
      if (live && live.session !== candidate.session && live.rttMs != null) return live.rttMs;
      return candidate.baselineRelayMs;
    }
    if (live && live.session !== candidate.session && live.transport === 'relay') {
      return this.host.relayMs(candidate.peerId, live);
    }
    return candidate.baselineRelayMs;
  }

  private passes(
    candidate: DirectCandidate,
    directMs: number | null,
    relayMs: number | null
  ): boolean {
    if (candidate.kind === 'promote') return promotePasses(directMs, relayMs);
    if (directMs == null || relayMs == null) return false;
    return candidate.samples.every((ms) => shouldPromoteDirect(ms, relayMs));
  }

  private reject(
    candidate: DirectCandidate,
    directMs: number | null,
    relayMs: number | null
  ): void {
    if (candidate.kind === 'promote') {
      this.end(candidate.session, candidate.peerId, 'dc-promote-reject', candidate.rtcEpoch);
      this.armPromoteBackoff(candidate.peerId);
      logLine(
        '[mesh][peer]',
        `dc_promote_reject peer=${candidate.peerId} dc_ms=${fmt(directMs)} live_ms=${fmt(relayMs)}`
      );
      return;
    }
    this.end(candidate.session, candidate.peerId, 'route-measure-reject', candidate.rtcEpoch);
    if (candidate.kind === 'degraded') this.host.armDegradedBackoff(candidate.peerId);
  }

  private accept(
    candidate: DirectCandidate,
    prev: LivePeer | undefined,
    directMs: number | null,
    relayMs: number | null
  ): void {
    rememberInstallMeta(candidate.session, {
      remoteAddress: candidate.remoteAddress,
      dcAttemptId: candidate.dcAttemptId,
      rtcEpoch: candidate.rtcEpoch,
      ...(candidate.quiesceCapable ? { quiesceCapable: true as const } : {}),
    });
    if (directMs != null) noteMeasuredProof(candidate.peerId);
    if (prev?.session === candidate.session) {
      adoptSessionRtcUnsub(candidate.session, prev);
      this.noteInstalled(candidate, prev, directMs, relayMs, false);
      return;
    }
    const kept = this.host.forceInstall(
      candidate.session,
      candidate.peerId,
      candidate.transport,
      candidate.initiatedBy,
      candidate.gen,
      candidate.remoteAddress,
      candidate.dcAttemptId,
      candidate.rtcEpoch
    );
    if (!kept) {
      this.reject(candidate, directMs, relayMs);
      return;
    }
    const live = this.host.live(candidate.peerId);
    adoptSessionRtcUnsub(candidate.session, live);
    this.noteInstalled(candidate, live ?? prev, directMs, relayMs, prev?.session !== kept);
    if (candidate.kind === 'degraded' && prev && prev.session !== kept) {
      this.host.finishRetire(prev, 'retired');
    }
  }

  private end(session: LinkSession, peerId: string, reason: string, epoch?: number): void {
    closeRouteSession({
      selfId: this.host.selfId(),
      peerId,
      session,
      also: this.host.live(peerId)?.session,
      reason,
      epoch,
    });
  }

  private noteInstalled(
    candidate: DirectCandidate,
    live: LivePeer | undefined,
    directMs: number | null,
    relayMs: number | null,
    switched: boolean
  ): void {
    if (live && directMs != null) {
      live.rttMs = directMs;
      markLiveDcProven(live);
    }
    this.host.recordOf(candidate.peerId).promoteBackoffUntil = 0;
    if (candidate.kind === 'degraded') {
      signalRoutePromoted(candidate.session);
      this.host.resetPeer(candidate.peerId);
      if (switched && candidate.fromTransport !== candidate.transport) {
        logLine(
          '[mesh][peer]',
          formatRouteSwitch({
            peer: candidate.peerId,
            from: candidate.fromTransport,
            to: candidate.transport,
            directMs,
            relayMs,
          })
        );
      }
      return;
    }
    logLine(
      '[mesh][peer]',
      `dc_promote_accept peer=${candidate.peerId} dc_ms=${fmt(directMs)} live_ms=${fmt(relayMs)}`
    );
  }

  private installNow(input: CandidateOffer): 'installed' | 'rejected' {
    rememberOfferMeta(input);
    const kept = this.host.forceInstall(
      input.session,
      input.peerNodeId,
      input.transport,
      input.initiatedBy,
      input.gen,
      input.remoteAddress ?? null,
      input.dcAttemptId ?? null,
      input.rtcEpoch
    );
    return kept ? 'installed' : 'rejected';
  }

  private armPromoteBackoff(peerId: string): void {
    this.host.recordOf(peerId).promoteBackoffUntil = this.host.now() + dcPromoteBackoffMs();
  }

  private stop(candidate: DirectCandidate): void {
    candidate.pingTimer?.clear();
    candidate.pingTimer = null;
    candidate.abort?.abort();
    candidate.abort = null;
  }
}

function offerAsTrack(input: CandidateOffer, live: LivePeer): TrackInterceptInput {
  return {
    session: input.session,
    peerNodeId: input.peerNodeId,
    transport: input.transport,
    initiatedBy: input.initiatedBy,
    gen: input.gen,
    remoteAddress: input.remoteAddress ?? null,
    dcAttemptId: input.dcAttemptId ?? null,
    rtcEpoch: input.rtcEpoch,
    quiesceCapable: input.quiesceCapable,
    prev: live,
  };
}

function rememberOfferMeta(input: CandidateOffer): void {
  rememberInstallMeta(input.session, {
    remoteAddress: input.remoteAddress ?? null,
    dcAttemptId: input.dcAttemptId ?? null,
    rtcEpoch: input.rtcEpoch,
    quiesceCapable: input.quiesceCapable === true,
  });
}

function promotePasses(directMs: number | null, relayMs: number | null): boolean {
  if (directMs == null) return true;
  if (relayMs == null) return true;
  return !dcPromoteTooSlow(directMs, relayMs, dcPromoteRatio(), dcPromoteAdditiveMs());
}

function noteMeasuredProof(peer: string): void {
  const generation = currentDcProofGeneration(peer);
  if (generation !== undefined) markDcLinkProof(peer, generation);
}

function fmt(value: number | null): string {
  return value == null ? '-' : String(Math.round(value));
}
