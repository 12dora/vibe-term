import {
  type DtlsFingerprint,
  encodeBase64url,
  normalizeFingerprint,
  parseSdpFingerprint,
} from '@tmex/shared/auth';
import type { RtcSignalMessage } from '../mesh-deps';
import { withPeerHandshakeTimeout } from '../peer-handshake-timeout';
import { PeerHandshakeError } from '../types';
import type { FanoutDataChannel } from './channel-fanout';
import {
  decodeCandidateSignal,
  decodeSdpSignal,
  isEmptyCandidate,
  maskIceAddress,
  parseIceCandidateType,
} from './ice';
import type { DataChannelLike, IceServerConfig, PeerConnectionLike, RtcIceConfig } from './native';
import { toUint8Array } from './native';
import {
  type IceCandidateTrace,
  createIceCandidateTrace,
  rtcLog,
  rtcLogCandidate,
  rtcLogIceFailed,
} from './rtc-log';

export type LocalDescriptionEvent = { sdp: string; type: string };

export type LocalDescriptionHub = {
  latest: LocalDescriptionEvent | null;
  listeners: Set<(description: LocalDescriptionEvent) => void>;
};

export type CandidatePairType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export type RtcDialAggregate = {
  lastEmittedAt: number | null;
  successes: Record<CandidatePairType, number>;
  failures: Record<CandidatePairType, number>;
  attempts: number;
  durationTotalMs: number;
  durationMaxMs: number;
};

export type SignalingAttemptState = {
  epoch?: number;
  answerApplied: boolean;
};

export function fingerprintsEqual(a: DtlsFingerprint, b: DtlsFingerprint): boolean {
  const left = normalizeFingerprint(a);
  const right = normalizeFingerprint(b);
  return left.algorithm === right.algorithm && left.value === right.value;
}

export function parseNonceMessage(msg: string | Buffer | ArrayBuffer): string | null {
  if (typeof msg === 'string') {
    try {
      const parsed = JSON.parse(msg) as { nonce?: unknown };
      return typeof parsed.nonce === 'string' ? parsed.nonce : null;
    } catch {
      return msg;
    }
  }
  const bytes = toUint8Array(msg);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { nonce?: unknown };
    if (typeof parsed.nonce === 'string') return parsed.nonce;
  } catch {
    if (bytes.byteLength === 32) return encodeBase64url(bytes);
  }
  return null;
}

export function createRtcSignalApplier(
  pc: PeerConnectionLike,
  peer: string,
  expect: 'offer' | 'answer',
  state: SignalingAttemptState,
  trace: IceCandidateTrace
): (message: RtcSignalMessage) => void {
  return (message) => {
    if (message.sdp) applyRemoteSdp(pc, peer, expect, state, message.sdp);
    if (message.candidate) applyRemoteCandidate(pc, peer, state, trace, message.candidate);
  };
}

function applyRemoteSdp(
  pc: PeerConnectionLike,
  peer: string,
  expect: 'offer' | 'answer',
  state: SignalingAttemptState,
  raw: string
): void {
  const decoded = decodeSdpSignal(raw);
  if (!decoded) return;
  if (decoded.type !== expect) {
    rtcLog('signal dropped', {
      peer,
      kind: 'sdp',
      cause: 'unexpected-type',
      expected: expect,
      received: decoded.type,
    });
    return;
  }
  if (epochMismatch(decoded.epoch, state.epoch, false)) {
    logEpochMismatch(peer, 'sdp', state.epoch, decoded.epoch);
    return;
  }
  if (expect === 'answer' && state.answerApplied) {
    rtcLog('signal dropped', { peer, kind: 'sdp', cause: 'duplicate-answer' });
    return;
  }
  if (expect === 'offer' && state.epoch === undefined) state.epoch = decoded.epoch;
  try {
    rtcLog('signal recv', { peer, kind: 'sdp', sdp_type: decoded.type });
    pc.setRemoteDescription(decoded.sdp, decoded.type);
    if (expect === 'answer') state.answerApplied = true;
  } catch (err) {
    logSignalApplyError(peer, 'sdp', err);
  }
}

function applyRemoteCandidate(
  pc: PeerConnectionLike,
  peer: string,
  state: SignalingAttemptState,
  trace: IceCandidateTrace,
  raw: string
): void {
  const decoded = decodeCandidateSignal(raw);
  if (!decoded || isEmptyCandidate(decoded.candidate)) return;
  if (epochMismatch(decoded.epoch, state.epoch, true)) {
    logEpochMismatch(peer, 'candidate', state.epoch, decoded.epoch);
    return;
  }
  try {
    rtcLogCandidate('recv', peer, decoded.candidate, trace);
    pc.addRemoteCandidate(decoded.candidate, decoded.mid);
  } catch (err) {
    logSignalApplyError(peer, 'candidate', err);
  }
}

function epochMismatch(
  received: number | undefined,
  expected: number | undefined,
  rejectBeforeEpoch: boolean
): boolean {
  if (received === undefined) return false;
  if (expected === undefined) return rejectBeforeEpoch;
  return received !== expected;
}

function logEpochMismatch(
  peer: string,
  kind: 'sdp' | 'candidate',
  expected: number | undefined,
  received: number | undefined
): void {
  rtcLog('signal dropped', {
    peer,
    kind,
    cause: 'epoch-mismatch',
    expected_epoch: expected,
    received_epoch: received,
  });
}

function logSignalApplyError(peer: string, kind: 'sdp' | 'candidate', err: unknown): void {
  rtcLog('signal dropped', {
    peer,
    kind,
    cause: err instanceof Error ? err.message : String(err),
  });
}

export function logRtcDialStart(
  peer: string,
  role: 'offerer' | 'answerer',
  ice: IceServerConfig,
  rtcConfig: RtcIceConfig
): void {
  const portRange =
    rtcConfig.portRangeBegin != null && rtcConfig.portRangeEnd != null
      ? `${rtcConfig.portRangeBegin}-${rtcConfig.portRangeEnd}`
      : undefined;
  rtcLog('dial start', {
    peer,
    role,
    stun_count: ice.stun.length,
    turn_enabled: Boolean(ice.turn),
    ice_tcp: rtcConfig.enableIceTcp,
    ice_udp_mux: rtcConfig.enableIceUdpMux,
    mtu: rtcConfig.mtu,
    bind_address: rtcConfig.bindAddress ? maskIceAddress(rtcConfig.bindAddress) : undefined,
    port_range: portRange,
  });
}

const CANDIDATE_PAIR_TYPES: CandidatePairType[] = ['host', 'srflx', 'prflx', 'relay', 'unknown'];

export function emptyPairCounts(): Record<CandidatePairType, number> {
  return { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
}

export function createRtcDialAggregate(): RtcDialAggregate {
  return {
    lastEmittedAt: null,
    successes: emptyPairCounts(),
    failures: emptyPairCounts(),
    attempts: 0,
    durationTotalMs: 0,
    durationMaxMs: 0,
  };
}

export function selectedCandidatePairType(pc: PeerConnectionLike): CandidatePairType {
  const pair = pc.getSelectedCandidatePair?.();
  const types = [
    pair?.local?.type ?? parseIceCandidateType(pair?.local?.candidate ?? ''),
    pair?.remote?.type ?? parseIceCandidateType(pair?.remote?.candidate ?? ''),
  ];
  for (const type of ['relay', 'prflx', 'srflx', 'host'] as const) {
    if (types.includes(type)) return type;
  }
  return 'unknown';
}

export function formatPairCounts(counts: Record<CandidatePairType, number>): string[] {
  return CANDIDATE_PAIR_TYPES.filter((type) => counts[type] > 0).map(
    (type) => `${type}:${counts[type]}`
  );
}

export function remainingDeadlineMs(deadline: number, message: string): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new PeerHandshakeError('timeout', message);
  return remaining;
}

export function waitForLocalFingerprint(
  pc: PeerConnectionLike,
  latest: LocalDescriptionEvent | null,
  subscribe: (listener: (description: LocalDescriptionEvent) => void) => () => void,
  timeoutMs: number
): Promise<DtlsFingerprint> {
  const current = latest ?? pc.localDescription();
  const currentFingerprint = current?.sdp ? parseSdpFingerprint(current.sdp) : null;
  if (currentFingerprint) return Promise.resolve(currentFingerprint);
  let unsubscribe = () => {};
  const fingerprint = new Promise<DtlsFingerprint>((resolve) => {
    unsubscribe = subscribe(({ sdp }) => {
      const parsed = parseSdpFingerprint(sdp);
      if (parsed) resolve(parsed);
    });
  });
  return withPeerHandshakeTimeout(
    fingerprint,
    timeoutMs,
    'local DTLS fingerprint unavailable'
  ).finally(unsubscribe);
}

export function logCreatedChannel(dc: DataChannelLike, peer: string): DataChannelLike {
  rtcLog('datachannel created', { peer, label: dc.getLabel?.() ?? 'peer' });
  return dc;
}

export function attachPcDiagnostics(
  pc: PeerConnectionLike,
  peer: string,
  trace: IceCandidateTrace
): () => void {
  let iceFailedLogged = false;
  const logIceFailed = () => {
    if (iceFailedLogged) return;
    iceFailedLogged = true;
    rtcLogIceFailed(peer, trace);
  };
  pc.onGatheringStateChange?.((state) => {
    rtcLog('gathering', { peer, state });
  });
  pc.onIceStateChange?.((state) => {
    rtcLog('ice', { peer, state });
    if (state === 'failed') logIceFailed();
    if (state === 'connected' || state === 'completed') logSelectedPair(pc, peer);
  });
  pc.onStateChange?.((state) => {
    rtcLog('peer state', { peer, state });
    if (state === 'failed') logIceFailed();
  });
  return () => {
    iceFailedLogged = true;
  };
}

function logSelectedPair(pc: PeerConnectionLike, peer: string): void {
  const pair = pc.getSelectedCandidatePair?.();
  if (!pair) return;
  rtcLog('selected pair', {
    peer,
    local_type: pair.local?.type ?? parseIceCandidateType(pair.local?.candidate ?? '') ?? undefined,
    remote_type:
      pair.remote?.type ?? parseIceCandidateType(pair.remote?.candidate ?? '') ?? undefined,
    local_addr: pair.local?.address ? maskIceAddress(pair.local.address) : undefined,
    remote_addr: pair.remote?.address ? maskIceAddress(pair.remote.address) : undefined,
  });
}

export function bindChannelDiagnostics(dc: DataChannelLike, peer: string): void {
  const label = dc.getLabel?.() ?? 'peer';
  dc.onOpen(() => {
    rtcLog('datachannel open', { peer, label });
  });
  dc.onError((err) => {
    rtcLog('datachannel error', { peer, label, err });
  });
  dc.onClosed(() => {
    rtcLog('datachannel closed', { peer, label });
  });
}

export function waitDataChannel(
  pc: PeerConnectionLike,
  timeoutMs: number,
  label?: string,
  peer?: string
): Promise<DataChannelLike> {
  return withPeerHandshakeTimeout(
    new Promise((resolve) => {
      pc.onDataChannel((dc) => {
        if (label && dc.getLabel && dc.getLabel() !== label) return;
        if (peer) rtcLog('datachannel received', { peer, label: dc.getLabel?.() ?? label ?? '' });
        resolve(dc);
      });
    }),
    timeoutMs,
    'datachannel open timeout'
  );
}

export function waitChannelOpen(dc: DataChannelLike, timeoutMs: number): Promise<void> {
  if (dc.isOpen()) return Promise.resolve();
  return withPeerHandshakeTimeout(
    new Promise((resolve, reject) => {
      dc.onOpen(() => resolve());
      dc.onError((err) => reject(new Error(err)));
      dc.onClosed(() => reject(new Error('channel closed before open')));
    }),
    timeoutMs,
    'datachannel open timeout'
  );
}

export function waitFirstMessage(
  dc: DataChannelLike,
  timeoutMs: number
): Promise<string | Buffer | ArrayBuffer> {
  const shifted = (dc as FanoutDataChannel).shiftPendingMessage?.();
  if (shifted !== undefined) return Promise.resolve(shifted);
  let unsubscribe: (() => void) | undefined;
  const first = new Promise<string | Buffer | ArrayBuffer>((resolve) => {
    const ret: unknown = dc.onMessage((msg) => {
      unsubscribe?.();
      unsubscribe = undefined;
      resolve(msg);
    });
    if (typeof ret === 'function') unsubscribe = ret as () => void;
  });
  return withPeerHandshakeTimeout(first, timeoutMs, 'sess nonce timeout').finally(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });
}
