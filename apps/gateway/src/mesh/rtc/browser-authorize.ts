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

/** 一个登录会话同时占住的浏览器 PC。重试会换 rtcSession，所以留 1 个在途 + 1 个替换。 */
export const RTC_AUTHORIZE_MAX_PER_SESSION = 2;
/** 一个账号多标签的上限。再往上就会挤占节点上其他用户的名额。 */
export const RTC_AUTHORIZE_MAX_PER_USER = 8;
/** 授权后一直没收到 offer / 没进入 accept 的记录。握手一旦开始仍用完整 TTL。 */
export const RTC_AUTHORIZE_PENDING_TTL_MS = 30_000;

/**
 * 客户端熔断按目标 node 计，不按会话。retryAfterMs 只是最短间隔，设太长会把别的标签一起冻住。
 * 真正挡住刷接口的是上面的会话/用户名额；连续失败仍由客户端 30s 熔断接管。
 */
export const DIRECT_BUSY_RETRY_MS = {
  timeout: 1_000,
  aborted: 500,
  failed: 2_000,
  capacity: 1_000,
} as const;

export type DirectBusyReason = keyof typeof DIRECT_BUSY_RETRY_MS;

export class AuthorizeBusyError extends Error {
  readonly reason = 'capacity' as const;

  constructor() {
    super('browser authorize capacity');
    this.name = 'AuthorizeBusyError';
  }
}

export function failReason(err: unknown): string {
  if (err instanceof AuthorizeBusyError) return err.reason;
  if (err instanceof PeerHandshakeError) return err.code;
  if (isAbortError(err)) return 'aborted';
  return 'failed';
}

export function directBusyBody(err: unknown): { reason: DirectBusyReason; retryAfterMs: number } {
  const raw = failReason(err);
  const reason: DirectBusyReason =
    raw === 'timeout' || raw === 'aborted' || raw === 'capacity' ? raw : 'failed';
  return { reason, retryAfterMs: DIRECT_BUSY_RETRY_MS[reason] };
}

export function pendingAuthorizeTtlMs(authorizeTtlMs: number): number {
  return Math.min(Math.max(1, authorizeTtlMs), RTC_AUTHORIZE_PENDING_TTL_MS);
}

/**
 * 名额分三层：同一 sid、同一 uid、整个节点。刷新已有 rtcSession 不占新名额。
 * 任一层满都拒绝，避免一个会话用随机 rtcSession 把节点 64 个名额占光。
 */
function countAuthorizeUsage(
  records: Iterable<BrowserAuthRecord>,
  input: { rtcSession: string; uid: string; sid?: string }
): { refresh: boolean; total: number; perSession: number; perUser: number } {
  let total = 0;
  let perSession = 0;
  let perUser = 0;
  for (const rec of records) {
    if (rec.rtcSession === input.rtcSession) return { refresh: true, total, perSession, perUser };
    total += 1;
    if (input.sid && rec.sid === input.sid) perSession += 1;
    if (input.uid && rec.uid === input.uid) perUser += 1;
  }
  return { refresh: false, total, perSession, perUser };
}

export function assertAuthorizeRoom(
  records: Iterable<BrowserAuthRecord>,
  input: { rtcSession: string; uid: string; sid?: string },
  max: number
): void {
  const usage = countAuthorizeUsage(records, input);
  if (usage.refresh) return;
  if (
    usage.total >= max ||
    usage.perSession >= RTC_AUTHORIZE_MAX_PER_SESSION ||
    usage.perUser >= RTC_AUTHORIZE_MAX_PER_USER
  ) {
    throw new AuthorizeBusyError();
  }
}

export function sweepExpiredBrowsers<T extends { exp: number; pc: PeerConnectionLike }>(
  records: Map<string, T>,
  now: number,
  close: (pc: PeerConnectionLike) => void
): void {
  for (const [id, rec] of records) {
    if (rec.exp > now) continue;
    close(rec.pc);
    records.delete(id);
  }
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
