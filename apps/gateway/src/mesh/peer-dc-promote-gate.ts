import type { LinkSession } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { envInt, logLine } from './mesh-log';
import { markLiveDcProven } from './peer-dc-proof';
import { measurePingRttMs, parseEchoedSentAt } from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import type { TrackIntercept, TrackInterceptInput } from './route-degrade';
import { currentDcProofGeneration, markDcLinkProof } from './rtc/dc-link-proof';
import type { MeshScheduler, PeerTransportKind } from './types';

export const DC_PROMOTE_RATIO_DEFAULT = 2;
export const DC_PROMOTE_ADDITIVE_MS_DEFAULT = 200;
export const DC_PROMOTE_BACKOFF_MS_DEFAULT = 60_000;
export const DC_PROMOTE_MEASURE_TIMEOUT_MS = 3_000;

export function envFloat(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

export function dcPromoteTooSlow(
  dcMs: number,
  currentMs: number,
  ratio = DC_PROMOTE_RATIO_DEFAULT,
  additiveMs = DC_PROMOTE_ADDITIVE_MS_DEFAULT
): boolean {
  return dcMs > Math.max(currentMs * ratio, currentMs + additiveMs);
}

export function mergeTrackIntercept(
  route: TrackIntercept | undefined,
  promote: TrackIntercept | undefined
): TrackIntercept {
  if (!route || route.action === 'continue') return promote ?? { action: 'continue' };
  return route;
}

export function attachDcPromote(host: {
  state: { scheduler: MeshScheduler; live: Map<string, LivePeer> };
  forceInstall: DcPromotePorts['forceInstall'];
  deps: { finishRetire: DcPromotePorts['finishRetire'] };
  measureRtt?: DcPromotePorts['measureRtt'];
}): DcPromoteGate {
  return new DcPromoteGate({
    now: () => host.state.scheduler.now(),
    scheduler: host.state.scheduler,
    forceInstall: (...args) => host.forceInstall(...args),
    finishRetire: (live, reason) => host.deps.finishRetire(live, reason),
    liveOf: (nodeId) => host.state.live.get(nodeId),
    measureRtt: host.measureRtt,
  });
}

export type DcPromotePorts = {
  now: () => number;
  scheduler: MeshScheduler;
  forceInstall: (
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress?: string | null,
    dcAttemptId?: string | null
  ) => LinkSession | null;
  finishRetire: (live: LivePeer, reason: string) => void;
  liveOf: (nodeId: string) => LivePeer | undefined;
  measureRtt?: (session: LinkSession, timeoutMs: number) => Promise<number | null>;
  ratio?: number;
  additiveMs?: number;
  backoffMs?: number;
  measureTimeoutMs?: number;
  log?: (msg: string) => void;
};

type PendingPromote = {
  session: LinkSession;
  abort: AbortController;
};

export class DcPromoteGate {
  private readonly ports: DcPromotePorts;
  private readonly ratio: number;
  private readonly additiveMs: number;
  private readonly backoffMs: number;
  private readonly measureTimeoutMs: number;
  private readonly backoffUntil = new Map<string, number>();
  private readonly pending = new Map<string, PendingPromote>();

  constructor(ports: DcPromotePorts) {
    this.ports = ports;
    this.ratio = ports.ratio ?? envFloat('VIBETERM_DC_PROMOTE_RATIO', DC_PROMOTE_RATIO_DEFAULT, 1);
    this.additiveMs =
      ports.additiveMs ??
      envInt('VIBETERM_DC_PROMOTE_ADDITIVE_MS', DC_PROMOTE_ADDITIVE_MS_DEFAULT, 0);
    this.backoffMs =
      ports.backoffMs ?? envInt('VIBETERM_DC_PROMOTE_BACKOFF_MS', DC_PROMOTE_BACKOFF_MS_DEFAULT, 1);
    this.measureTimeoutMs = ports.measureTimeoutMs ?? DC_PROMOTE_MEASURE_TIMEOUT_MS;
  }

  decide(input: TrackInterceptInput): TrackIntercept {
    if (input.transport === 'ws-secure' && input.prev?.transport === 'relay') {
      this.armBackoff(input.peerNodeId);
    }
    if (input.transport !== 'dc') return { action: 'continue' };
    if (!input.prev || input.prev.session === input.session) return { action: 'continue' };
    if (input.prev.transport === 'dc') return { action: 'continue' };
    if (this.ports.now() < (this.backoffUntil.get(input.peerNodeId) ?? 0)) {
      return { action: 'reject', reason: 'dc-promote-backoff' };
    }
    if (input.prev.rttMs == null) return { action: 'continue' };
    this.hold(input);
    return { action: 'hold' };
  }

  private hold(input: TrackInterceptInput): void {
    this.dropPending(input.peerNodeId, 'replaced-candidate');
    const abort = new AbortController();
    this.pending.set(input.peerNodeId, { session: input.session, abort });
    void this.settle(input, abort.signal);
  }

  private async settle(input: TrackInterceptInput, signal: AbortSignal): Promise<void> {
    const dcMs = await this.measure(input.session, signal);
    if (this.pending.get(input.peerNodeId)?.session !== input.session) return;
    this.pending.delete(input.peerNodeId);
    const live = this.ports.liveOf(input.peerNodeId);
    const currentMs = live?.rttMs ?? input.prev?.rttMs ?? null;
    if (dcMs != null && this.shouldReject(dcMs, currentMs)) {
      this.rejectCandidate(input, dcMs, currentMs);
      return;
    }
    this.acceptCandidate(input, live ?? input.prev, dcMs);
  }

  private shouldReject(dcMs: number, currentMs: number | null): boolean {
    if (currentMs == null) return false;
    return dcPromoteTooSlow(dcMs, currentMs, this.ratio, this.additiveMs);
  }

  private rejectCandidate(
    input: TrackInterceptInput,
    dcMs: number | null,
    currentMs: number | null
  ): void {
    quiet(() => input.session.close('dc-promote-reject'));
    this.armBackoff(input.peerNodeId);
    this.logReject(input.peerNodeId, dcMs, currentMs);
  }

  private acceptCandidate(
    input: TrackInterceptInput,
    prev: LivePeer | undefined,
    dcMs: number | null
  ): void {
    const live = this.ports.liveOf(input.peerNodeId);
    if (live?.session === input.session) {
      if (dcMs != null) {
        live.rttMs = dcMs;
        markLiveDcProven(live);
      }
      this.backoffUntil.delete(input.peerNodeId);
      return;
    }
    // 测量到的 mux pong 就是证明。先标上，再安装，避免同步 quiesce 在标志落下之前拆掉 relay。
    if (dcMs != null) this.noteMeasuredProof(input.peerNodeId);
    const kept = this.ports.forceInstall(
      input.session,
      input.peerNodeId,
      'dc',
      input.initiatedBy,
      input.gen,
      input.remoteAddress,
      input.dcAttemptId
    );
    if (!kept) {
      this.rejectCandidate(input, dcMs, prev?.rttMs ?? null);
      return;
    }
    const installed = this.ports.liveOf(input.peerNodeId);
    if (installed && dcMs != null) {
      installed.rttMs = dcMs;
      markLiveDcProven(installed);
    }
    this.backoffUntil.delete(input.peerNodeId);
  }

  private noteMeasuredProof(peer: string): void {
    const generation = currentDcProofGeneration(peer);
    if (generation !== undefined) markDcLinkProof(peer, generation);
  }

  private measure(session: LinkSession, signal: AbortSignal): Promise<number | null> {
    if (this.ports.measureRtt) return this.ports.measureRtt(session, this.measureTimeoutMs);
    return pingSessionRtt(session, this.measureTimeoutMs, this.ports.scheduler, signal);
  }

  private armBackoff(nodeId: string): void {
    this.backoffUntil.set(nodeId, this.ports.now() + this.backoffMs);
  }

  private dropPending(nodeId: string, reason: string): void {
    const pending = this.pending.get(nodeId);
    if (!pending) return;
    this.pending.delete(nodeId);
    pending.abort.abort();
    quiet(() => pending.session.close(reason));
  }

  private logReject(peer: string, dcMs: number | null, currentMs: number | null): void {
    const log = this.ports.log ?? ((msg) => logLine('[mesh][peer]', msg));
    log(`dc_promote_reject peer=${peer} dc_ms=${dcMs ?? '-'} live_ms=${currentMs ?? '-'}`);
  }
}

async function pingSessionRtt(
  session: LinkSession,
  timeoutMs: number,
  scheduler: MeshScheduler,
  signal: AbortSignal
): Promise<number | null> {
  let sentAt: number | null = null;
  let settled = false;
  const sample = new Promise<number | null>((resolve) => {
    session.ctl.onMessage((bytes) => {
      if (settled) return;
      const msg = parseOpenPayload(bytes);
      if (!msg || msg.t !== 'pong') return;
      settled = true;
      resolve(measurePingRttMs(performance.now(), parseEchoedSentAt(msg.sentAt), sentAt));
    });
    sentAt = performance.now();
    quiet(() => session.ctl.send(encodeJsonBytes({ t: 'ping', sentAt })));
  });
  const timeout = scheduler.sleep(timeoutMs, signal).then(
    () => null,
    () => null
  );
  return Promise.race([sample, timeout]);
}
