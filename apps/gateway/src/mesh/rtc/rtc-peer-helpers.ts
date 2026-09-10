import {
  type DtlsFingerprint,
  encodeBase64url,
  normalizeFingerprint,
  parseSdpFingerprint,
} from '@vibeterm/shared/auth';
import { withPeerHandshakeTimeout } from '../peer-handshake-timeout';
import { PeerHandshakeError } from '../types';
import type { FanoutDataChannel } from './channel-fanout';
import { maskIceAddress, parseIceCandidateType } from './ice';
import type { DataChannelLike, IceServerConfig, PeerConnectionLike, RtcIceConfig } from './native';
import { toUint8Array } from './native';
import { type RtcDialProgress, rtcFailureStage, rtcGatherFailureHint } from './rtc-dial-progress';
import {
  type IceCandidateTrace,
  type RtcLogContext,
  iceTypesOf,
  rtcLog,
  rtcLogIceFailed,
} from './rtc-log';

export type { SignalingAttemptState } from './rtc-signal-apply';
export { createRtcSignalApplier, createSignalingAttemptState } from './rtc-signal-apply';

export const PEER_CHANNEL_LABEL = 'peer';
export const SESS_CHANNEL_LABEL = 'sess';

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

export function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

export function raceWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortErrorFromSignal(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
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
  rtcLog('datachannel created', { peer, label: dc.getLabel?.() ?? PEER_CHANNEL_LABEL });
  return dc;
}

export function attachPcDiagnostics(
  pc: PeerConnectionLike,
  peer: string,
  trace: IceCandidateTrace,
  opts?: { ice?: IceServerConfig; progress?: RtcDialProgress; ctx?: RtcLogContext }
): () => void {
  let iceFailedLogged = false;
  let gatherSummaryLogged = false;
  const progress = opts?.progress;
  const ice = opts?.ice;
  const ctx = opts?.ctx ?? {};
  const logIceFailed = () => {
    if (iceFailedLogged) return;
    iceFailedLogged = true;
    rtcLogIceFailed(peer, trace);
  };
  const noteSelected = () => {
    if (progress) progress.selectedPair ||= Boolean(pc.getSelectedCandidatePair?.());
    logSelectedPair(pc, peer);
  };
  pc.onGatheringStateChange?.((state) => {
    rtcLog('gathering', { ...ctx, peer, state });
    if (state !== 'complete') return;
    if (progress) progress.gatheringComplete = true;
    if (gatherSummaryLogged) return;
    gatherSummaryLogged = true;
    rtcLog('gather summary', {
      ...ctx,
      peer,
      host: trace.localCounts.host,
      srflx: trace.localCounts.srflx,
      relay: trace.localCounts.relay,
      stun_count: ice?.stun.length ?? 0,
      turn: Boolean(ice?.turn),
    });
  });
  pc.onIceStateChange?.((state) => {
    rtcLog('ice', { ...ctx, peer, state });
    if (state === 'failed') logIceFailed();
    if (state === 'connected' || state === 'completed') noteSelected();
  });
  pc.onStateChange?.((state) => {
    rtcLog('peer state', { ...ctx, peer, state });
    if (state === 'failed') logIceFailed();
  });
  return () => {
    iceFailedLogged = true;
  };
}

export function logRtcDialTimeout(
  peer: string,
  pc: PeerConnectionLike,
  trace: IceCandidateTrace,
  progress: RtcDialProgress,
  ice: IceServerConfig,
  reason: string
): void {
  if (pc.getSelectedCandidatePair?.()) progress.selectedPair = true;
  rtcLog('dial timeout', {
    peer,
    stage: rtcFailureStage(progress),
    local_types: iceTypesOf(trace, 'local'),
    remote_types: iceTypesOf(trace, 'remote'),
    stun_count: ice.stun.length,
    turn: Boolean(ice.turn),
    reason,
  });
}

export function timeoutFailureMessage(
  progress: RtcDialProgress,
  ice: IceServerConfig,
  localCounts: { srflx: number; relay: number },
  fallback: string
): string {
  return rtcGatherFailureHint(progress, ice, localCounts) ?? fallback;
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
  const label = dc.getLabel?.() ?? PEER_CHANNEL_LABEL;
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
