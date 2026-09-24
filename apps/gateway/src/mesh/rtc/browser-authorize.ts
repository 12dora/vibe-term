import { type DtlsFingerprint, normalizeFingerprint } from '@vibeterm/shared/auth';
import type { RtcAuthorizeBrowserInput, RtcAuthorizeBrowserResult } from '../mesh-deps';
import { withPeerHandshakeTimeout } from '../peer-handshake-timeout';
import { PeerHandshakeError } from '../types';
import type { DataChannelLike, PeerConnectionLike } from './native';
import { type LocalDescriptionFanout, raceWithAbort } from './rtc-peer-helpers';

/** 不是 `sess`：浏览器才是 offerer，这条通道只用来逼出本机证书指纹。 */
export const BROWSER_FP_PROBE_LABEL = 'vt-fp-probe';
/** 入口转发预算下限是 5s，指纹等待必须更短，避免 15s 后才变成没人看的 500。 */
export const BROWSER_AUTHORIZE_FINGERPRINT_TIMEOUT_MS = 3_000;

export type BrowserAuthRecord = {
  rtcSession: string;
  uid: string;
  sid: string;
  via: string;
  connectionId: string;
  nonce: Uint8Array | null;
  fpBrowser: DtlsFingerprint | null;
  fpNode: DtlsFingerprint | null;
  exp: number;
  pc: PeerConnectionLike;
};

export type GrantOpts = {
  now: number;
  ttlMs: number;
  handshakeTimeoutMs: number;
  signal?: AbortSignal;
  fanout: LocalDescriptionFanout;
  waitFingerprint: (pc: PeerConnectionLike, timeoutMs: number) => Promise<DtlsFingerprint>;
};

type PrimeOpts = {
  pc: PeerConnectionLike;
  fanout: LocalDescriptionFanout;
  waitFingerprint: (pc: PeerConnectionLike, timeoutMs: number) => Promise<DtlsFingerprint>;
  handshakeTimeoutMs: number;
  signal?: AbortSignal;
};

const primes = new WeakMap<PeerConnectionLike, Promise<DtlsFingerprint>>();

export function emptyBrowserRecord(
  rtcSession: string,
  pc: PeerConnectionLike,
  exp: number
): BrowserAuthRecord {
  return {
    rtcSession,
    uid: '',
    sid: '',
    via: '',
    connectionId: '',
    nonce: null,
    fpBrowser: null,
    fpNode: null,
    exp,
    pc,
  };
}

export function failReason(err: unknown): string {
  if (err instanceof PeerHandshakeError) return err.code;
  if (isAbortError(err)) return 'aborted';
  return 'failed';
}

export async function grantBrowser(
  rec: BrowserAuthRecord,
  input: RtcAuthorizeBrowserInput,
  opts: GrantOpts
): Promise<RtcAuthorizeBrowserResult> {
  rec.uid = input.uid;
  rec.sid = input.sid ?? '';
  rec.via = input.via;
  rec.connectionId = input.connectionId ?? '';
  rec.fpBrowser = normalizeFingerprint(input.fpBrowser);
  rec.exp = opts.now + opts.ttlMs;
  if (!rec.fpNode) {
    rec.fpNode = await primeBrowserAnswerer({
      pc: rec.pc,
      fanout: opts.fanout,
      waitFingerprint: opts.waitFingerprint,
      handshakeTimeoutMs: opts.handshakeTimeoutMs,
      signal: opts.signal,
    });
  }
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  rec.nonce = nonce;
  return { nonce, fpNode: rec.fpNode };
}

export function primeBrowserAnswerer(opts: PrimeOpts): Promise<DtlsFingerprint> {
  const current = primes.get(opts.pc);
  if (current) return current;
  const pending = runPrime(opts).finally(() => {
    if (primes.get(opts.pc) === pending) primes.delete(opts.pc);
  });
  primes.set(opts.pc, pending);
  return pending;
}

async function runPrime(opts: PrimeOpts): Promise<DtlsFingerprint> {
  throwIfAborted(opts.signal);
  const timeoutMs = fingerprintBudget(opts.handshakeTimeoutMs);
  const probe = opts.pc.createDataChannel(BROWSER_FP_PROBE_LABEL);
  try {
    const fp = await raceWithAbort(opts.waitFingerprint(opts.pc, timeoutMs), opts.signal);
    closeQuiet(probe);
    rollbackBrowserProbe(opts.pc);
    // createDataChannel 的 onLocalDescription 走 napi 线程回调，晚于微任务。
    // 不把它消化掉，accept 订上信令后会把这条探测 offer 发给浏览器。
    await drainLocalDescription(opts.fanout, timeoutMs, opts.signal);
    assertStable(opts.pc);
    return fp;
  } catch (err) {
    closeQuiet(probe);
    rollbackQuiet(opts.pc);
    throw err;
  }
}

function fingerprintBudget(handshakeTimeoutMs: number): number {
  if (handshakeTimeoutMs < BROWSER_AUTHORIZE_FINGERPRINT_TIMEOUT_MS) {
    return Math.max(1, handshakeTimeoutMs);
  }
  return BROWSER_AUTHORIZE_FINGERPRINT_TIMEOUT_MS;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function signalingOf(pc: PeerConnectionLike): string | null {
  const read = (pc as { signalingState?: () => string }).signalingState;
  if (!read) return null;
  try {
    return read.call(pc);
  } catch {
    return null;
  }
}

function closeQuiet(channel: DataChannelLike | null): void {
  try {
    channel?.close();
  } catch {
    // 探测通道关闭失败不阻止回滚；连接本身会在授权失败时关掉。
  }
}

function rollbackBrowserProbe(pc: PeerConnectionLike): void {
  if (signalingOf(pc) !== 'have-local-offer') return;
  // 空 PC 上无参 setLocalDescription 会抛出接不住的 C++ 异常；只在已有 offer 时回滚。
  pc.setLocalDescription?.('rollback');
  assertStable(pc);
}

function rollbackQuiet(pc: PeerConnectionLike): void {
  try {
    if (signalingOf(pc) === 'have-local-offer') pc.setLocalDescription?.('rollback');
  } catch {
    // 失败路径只接 JS 错误。libdatachannel 的 C++ 异常不会进这里。
  }
}

function assertStable(pc: PeerConnectionLike): void {
  const state = signalingOf(pc);
  if (state && state !== 'stable') {
    throw new PeerHandshakeError('protocol', 'browser answerer did not return to stable');
  }
}

function drainLocalDescription(
  fanout: LocalDescriptionFanout,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (fanout.latest?.sdp) return Promise.resolve();
  let detach = () => {};
  const drained = new Promise<void>((resolve) => {
    const onDescription = () => {
      detach();
      resolve();
    };
    detach = () => fanout.listeners.delete(onDescription);
    fanout.listeners.add(onDescription);
    if (fanout.latest?.sdp) onDescription();
  });
  return raceWithAbort(
    withPeerHandshakeTimeout(drained, timeoutMs, 'local DTLS fingerprint unavailable'),
    signal
  ).finally(() => detach());
}
