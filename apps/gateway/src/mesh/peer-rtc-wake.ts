import { decodeCertificate } from '@tmex/shared/auth';
import type { UserStore } from '../auth/user-store';
import type { RtcSignalMessage } from './mesh-deps';
import {
  RTC_WAKE_DOMAIN,
  RTC_WAKE_MAX_SKEW_MS,
  type RtcSignaling,
  type RtcWakeFields,
  decodeSdpSignal,
  encodeRtcWakeSdp,
  isCanonicalRtcWakeNonce,
  parseRtcWakeSdp,
  peerRtcSession,
  verifyRtcWakeSignature,
} from './rtc/ice';
import { rtcLog, rtcLogRateLimited } from './rtc/rtc-log';
import type { MeshIdentity, MeshScheduler, PeerTransportKind } from './types';
import type { UplinkRtcSignal } from './uplink-protocol';

export const PEER_RTC_WAKE_COOLDOWN_MS = 5_000;
export const PEER_RTC_WAKE_NONCE_CACHE = 256;
export const PEER_RTC_WAKE_VERIFY_BURST = 5;
export const PEER_RTC_WAKE_VERIFY_WINDOW_MS = 5_000;
export const RTC_SIGNAL_INBOX_TTL_MS = 30_000;

export type RtcSignalInboxEntry = {
  message: RtcSignalMessage;
  receivedAt: number;
};

export function deliverRtcSignal(
  listeners: Set<(message: RtcSignalMessage) => void> | undefined,
  message: RtcSignalMessage
): boolean {
  if (!listeners || listeners.size === 0) return false;
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {
      // listener errors must not break signaling
    }
  }
  return true;
}

export function shouldDropUnboundRtcSignal(input: {
  selfNodeId: string;
  fromNodeId: string;
  message: RtcSignalMessage;
  attemptExists: boolean;
}): boolean {
  const decoded = input.message.sdp ? decodeSdpSignal(input.message.sdp) : null;
  const answerToOfferer =
    decoded?.type === 'answer' && input.selfNodeId.toLowerCase() < input.fromNodeId.toLowerCase();
  return answerToOfferer || Boolean(input.message.candidate && !input.attemptExists);
}

export function shouldStartRtcAttempt(input: {
  allow: boolean;
  pending: boolean;
  upgrading: boolean;
  live: boolean;
  wantsUpgrade: boolean;
}): boolean {
  return input.allow && !input.pending && !input.upgrading && (!input.live || input.wantsUpgrade);
}

export type WakeGate = {
  inflight: boolean;
  nextEligibleAt: number;
  deferredAbort: AbortController | null;
};

export type IncomingWakeGate = {
  nextEligibleAt: number;
  verifyTokens: number;
  verifyRefillAt: number;
};

export type RtcWakeLivePeer = {
  transport: PeerTransportKind;
};

export type RtcWakePorts = {
  identity: MeshIdentity;
  userStore: UserStore;
  scheduler: MeshScheduler;
  sendRtcSignal: (peerNodeId: string, msg: RtcSignalMessage) => void;
  dcCapable: (nodeId: string) => boolean;
  maybeUpgrade: (nodeId: string, opts: { cooldown: boolean; userPath?: boolean }) => void;
  stopSignal: () => AbortSignal;
  stopped: () => boolean;
  isTrusted: (nodeId: string) => boolean;
  live: () => Map<string, RtcWakeLivePeer>;
  shouldTryDc: (nodeId: string) => boolean;
  pending: () => Map<string, Promise<unknown>>;
  upgrading: () => Map<string, Promise<unknown>>;
  wantsUpgrade: (live: RtcWakeLivePeer) => boolean;
  getLink: (nodeId: string) => Promise<unknown>;
  rtcListeners: () => Map<string, Set<(msg: RtcSignalMessage) => void>>;
  rtcInbox: () => Map<string, RtcSignalInboxEntry[]>;
  sendPeerCtl: (live: RtcWakeLivePeer, payload: Record<string, unknown>) => void;
  ensureDcSession: ((peerNodeId: string, rtcSession: string) => void) | null;
  uplinkSendCtl: (payload: UplinkRtcSignal) => void;
};

export class RtcWakeGate {
  readonly wakeGate = new Map<string, WakeGate>();
  readonly incomingWakeGate = new Map<string, IncomingWakeGate>();
  readonly rtcWakeNonces = new Map<string, Map<string, number>>();
  private readonly ports: RtcWakePorts;

  constructor(ports: RtcWakePorts) {
    this.ports = ports;
  }

  dispose(): void {
    this.abortDeferredRtcWakes();
    this.wakeGate.clear();
    this.incomingWakeGate.clear();
    this.rtcWakeNonces.clear();
  }

  forgetPeer(nodeId: string): void {
    this.releaseRtcWakeAttempt(nodeId);
    this.wakeGate.delete(nodeId);
    this.incomingWakeGate.delete(nodeId);
    this.rtcWakeNonces.delete(nodeId.toLowerCase());
  }

  signalingFor(peerNodeId: string): RtcSignaling {
    return {
      send: (msg) => this.sendRtcSignal(peerNodeId, msg),
      onMessage: (cb) => {
        const listeners = this.ports.rtcListeners();
        let set = listeners.get(peerNodeId);
        if (!set) {
          set = new Set();
          listeners.set(peerNodeId, set);
        }
        set.add(cb);
        const inbox = this.ports.rtcInbox();
        const queued = inbox.get(peerNodeId);
        if (queued && queued.length > 0) {
          inbox.delete(peerNodeId);
          const cutoff = this.ports.scheduler.now() - RTC_SIGNAL_INBOX_TTL_MS;
          const fresh = queued.filter((entry) => entry.receivedAt >= cutoff);
          queueMicrotask(() => {
            if (!set?.has(cb)) return;
            for (const entry of fresh) cb(entry.message);
          });
        }
        return () => {
          set?.delete(cb);
          if (set && set.size === 0) listeners.delete(peerNodeId);
        };
      },
    };
  }

  sendRtcSignal(peerNodeId: string, msg: RtcSignalMessage): void {
    const payload = {
      t: 'rtc.signal' as const,
      rtcSession: msg.rtcSession,
      from: msg.from,
      to: msg.to,
      ...(msg.sdp ? { sdp: msg.sdp } : {}),
      ...(msg.candidate ? { candidate: msg.candidate } : {}),
    };
    const live = this.ports.live().get(peerNodeId);
    if (live && live.transport !== 'dc') {
      this.ports.sendPeerCtl(live, payload);
      return;
    }
    this.ports.ensureDcSession?.(peerNodeId, msg.rtcSession);
    try {
      this.ports.uplinkSendCtl(payload);
    } catch {
      // uplink offline
    }
  }

  handleIncomingRtcWake(fromNodeId: string, msg: RtcSignalMessage): void {
    if (this.ports.stopped()) return;
    const now = this.ports.scheduler.now();
    const gate = this.ensureIncomingWakeGate(fromNodeId);
    const drop = (tag: string, dropped: string, event = 'signal recv') =>
      rtcLogRateLimited(`wake:${tag}:${fromNodeId}`, event, {
        peer: fromNodeId,
        kind: 'wake',
        dropped,
      });
    if (now < gate.nextEligibleAt) {
      drop('rate', 'rate');
      return;
    }
    if (!this.consumeWakeVerifyToken(gate, now)) {
      drop('rate', 'rate');
      return;
    }
    const wake = parseRtcWakeSdp(msg.sdp);
    if (!wake || !this.acceptSignedRtcWake(fromNodeId, msg, wake)) {
      drop('auth', 'auth', 'wake rejected');
      return;
    }
    gate.nextEligibleAt = now + PEER_RTC_WAKE_COOLDOWN_MS;
    if (this.ports.identity.nodeId.toLowerCase() >= fromNodeId.toLowerCase()) {
      drop('role', 'not-offerer');
      return;
    }
    rtcLog('signal recv', { peer: fromNodeId, kind: 'wake' });
    const live = this.ports.live().get(fromNodeId);
    if (live?.transport === 'dc' || !this.ports.shouldTryDc(fromNodeId)) return;
    if (this.ports.pending().has(fromNodeId) || this.ports.upgrading().has(fromNodeId)) return;
    if (live && !this.ports.wantsUpgrade(live)) return;
    void this.ports.getLink(fromNodeId).catch(() => undefined);
  }

  acceptSignedRtcWake(fromNodeId: string, msg: RtcSignalMessage, wake: RtcWakeFields): boolean {
    if (wake.domain !== RTC_WAKE_DOMAIN) return false;
    if (wake.from.toLowerCase() !== fromNodeId.toLowerCase()) return false;
    if (wake.to.toLowerCase() !== this.ports.identity.nodeId.toLowerCase()) return false;
    const session = peerRtcSession(wake.from, wake.to);
    if (wake.rtcSession.toLowerCase() !== session.toLowerCase()) return false;
    if (msg.rtcSession && msg.rtcSession.toLowerCase() !== session.toLowerCase()) return false;
    if (Math.abs(this.ports.scheduler.now() - wake.issued_at) > RTC_WAKE_MAX_SKEW_MS) return false;
    if (!this.ports.isTrusted(wake.from)) return false;
    const cert = this.ports.userStore.getCert(wake.from);
    if (!cert) return false;
    let edPk: Uint8Array;
    try {
      edPk = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      return false;
    }
    if (!isCanonicalRtcWakeNonce(wake.nonce)) return false;
    if (!verifyRtcWakeSignature(wake, edPk)) return false;
    return this.rememberRtcWakeNonce(fromNodeId, wake.nonce, wake.issued_at);
  }

  rememberRtcWakeNonce(fromNodeId: string, nonce: string, issuedAt: number): boolean {
    const from = fromNodeId.toLowerCase();
    let peer = this.rtcWakeNonces.get(from);
    if (!peer) {
      peer = new Map();
      this.rtcWakeNonces.set(from, peer);
    }
    this.pruneRtcWakeNonces(peer);
    if (peer.has(nonce)) return false;
    if (peer.size >= PEER_RTC_WAKE_NONCE_CACHE) return false;
    peer.set(nonce, issuedAt + RTC_WAKE_MAX_SKEW_MS);
    return true;
  }

  pruneRtcWakeNonces(peer: Map<string, number>): void {
    const now = this.ports.scheduler.now();
    for (const [nonce, exp] of peer) {
      if (now > exp) peer.delete(nonce);
    }
  }

  ensureIncomingWakeGate(fromNodeId: string): IncomingWakeGate {
    let gate = this.incomingWakeGate.get(fromNodeId);
    if (!gate) {
      gate = {
        nextEligibleAt: 0,
        verifyTokens: PEER_RTC_WAKE_VERIFY_BURST,
        verifyRefillAt: 0,
      };
      this.incomingWakeGate.set(fromNodeId, gate);
    }
    return gate;
  }

  consumeWakeVerifyToken(gate: IncomingWakeGate, now: number): boolean {
    const interval = PEER_RTC_WAKE_VERIFY_WINDOW_MS / PEER_RTC_WAKE_VERIFY_BURST;
    if (!(interval > 0)) return false;
    if (gate.verifyRefillAt <= 0) {
      gate.verifyTokens = PEER_RTC_WAKE_VERIFY_BURST;
      gate.verifyRefillAt = now;
    } else if (now > gate.verifyRefillAt) {
      const add = Math.floor((now - gate.verifyRefillAt) / interval);
      if (add > 0) {
        gate.verifyTokens = Math.min(PEER_RTC_WAKE_VERIFY_BURST, gate.verifyTokens + add);
        gate.verifyRefillAt += add * interval;
      }
    }
    if (gate.verifyTokens < 1) return false;
    gate.verifyTokens -= 1;
    return true;
  }

  ensureWakeGate(peerNodeId: string): WakeGate {
    let gate = this.wakeGate.get(peerNodeId);
    if (!gate) {
      gate = { inflight: false, nextEligibleAt: 0, deferredAbort: null };
      this.wakeGate.set(peerNodeId, gate);
    }
    return gate;
  }

  abortDeferredRtcWakes(): void {
    for (const gate of this.wakeGate.values()) {
      this.disarmDeferredRtcWake(gate);
    }
  }

  disarmDeferredRtcWake(gate: WakeGate): void {
    gate.deferredAbort?.abort();
    gate.deferredAbort = null;
  }

  armDeferredRtcWake(peerNodeId: string, gate: WakeGate): void {
    if (gate.deferredAbort || this.ports.stopped()) return;
    const delay = Math.max(0, gate.nextEligibleAt - this.ports.scheduler.now());
    const abort = new AbortController();
    gate.deferredAbort = abort;
    const onStop = () => abort.abort();
    this.ports.stopSignal().addEventListener('abort', onStop, { once: true });
    void this.ports.scheduler.sleep(delay, abort.signal).then(
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (gate.deferredAbort === abort) gate.deferredAbort = null;
        if (this.ports.stopped()) return;
        gate.nextEligibleAt = Math.min(gate.nextEligibleAt, this.ports.scheduler.now());
        this.dispatchRtcWake(peerNodeId);
      },
      () => {
        this.ports.stopSignal().removeEventListener('abort', onStop);
        if (gate.deferredAbort === abort) gate.deferredAbort = null;
      }
    );
  }

  releaseRtcWakeAttempt(peerNodeId: string): void {
    const gate = this.wakeGate.get(peerNodeId);
    if (!gate) return;
    gate.inflight = false;
    this.disarmDeferredRtcWake(gate);
  }

  dispatchRtcWake(peerNodeId: string): void {
    if (this.ports.identity.nodeId.toLowerCase() < peerNodeId.toLowerCase()) return;
    if (this.ports.live().get(peerNodeId)?.transport === 'dc') {
      this.releaseRtcWakeAttempt(peerNodeId);
      return;
    }
    if (!this.ports.shouldTryDc(peerNodeId)) return;
    const gate = this.ensureWakeGate(peerNodeId);
    if (gate.inflight) return;
    const now = this.ports.scheduler.now();
    if (now < gate.nextEligibleAt) {
      this.armDeferredRtcWake(peerNodeId, gate);
      return;
    }
    gate.inflight = true;
    gate.nextEligibleAt = now + PEER_RTC_WAKE_COOLDOWN_MS;
    rtcLog('signal send', { peer: peerNodeId, kind: 'wake' });
    this.sendRtcSignal(peerNodeId, {
      rtcSession: peerRtcSession(this.ports.identity.nodeId, peerNodeId),
      from: 'node',
      to: peerNodeId,
      sdp: encodeRtcWakeSdp({
        from: this.ports.identity.nodeId,
        to: peerNodeId,
        rtcSession: peerRtcSession(this.ports.identity.nodeId, peerNodeId),
        issuedAt: now,
        secretKey: this.ports.identity.edSecretKey,
      }),
    });
  }
}
