import { decodeSdpSignal } from './ice';
import type { DcOfferBlockReason } from './rtc-dial-breaker';
import { isSupersededDcLoss } from './rtc-dial-progress';
import { RTC_DECLINE_BACKOFF_CAP_MS } from './rtc-force-probe';

/** 信令里没有独立的 busy/reject。decline 走现有 rtc.signal SDP：旧对端把未知 type 丢掉，不抛。 */
export const DC_OFFER_DECLINE_TYPE = 'decline';

export type DcOfferDeclineReason = DcOfferBlockReason;

export type OffererSdpReaction = 'apply-answer' | 'abort-now' | 'ignore';

export type DcOfferDeclineExtra = {
  until?: number | null;
  retryAfterMs?: number | null;
  epoch?: number | null;
};

export type DcOfferDeclineDetail = {
  reason: DcOfferDeclineReason;
  until: number | null;
  retryAfterMs: number | null;
  epoch: number | null;
};

/**
 * 形状仍是 `{type:'decline', sdp}`。until / retryAfterMs 是旧解码器会忽略的附加字段。
 * 优先带 retryAfterMs：对端时钟和本端不必对齐。
 */
export function encodeDcOfferDecline(
  reason: DcOfferDeclineReason,
  extra?: DcOfferDeclineExtra
): string {
  const body: Record<string, unknown> = { type: DC_OFFER_DECLINE_TYPE, sdp: reason };
  if (extra?.until != null && Number.isFinite(extra.until)) body.until = extra.until;
  if (
    extra?.retryAfterMs != null &&
    extra.retryAfterMs > 0 &&
    Number.isFinite(extra.retryAfterMs)
  ) {
    body.retryAfterMs = Math.round(extra.retryAfterMs);
  }
  if (extra?.epoch != null && Number.isSafeInteger(extra.epoch) && extra.epoch >= 0) {
    body.epoch = extra.epoch;
  }
  return JSON.stringify(body);
}

export function readDcOfferDecline(raw: string | null | undefined): DcOfferDeclineReason | null {
  return readDcOfferDeclineDetail(raw)?.reason ?? null;
}

export function readDcOfferDeclineDetail(
  raw: string | null | undefined
): DcOfferDeclineDetail | null {
  if (!isDcOfferDecline(raw) || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      sdp?: unknown;
      until?: unknown;
      retryAfterMs?: unknown;
      epoch?: unknown;
    };
    if (parsed.sdp !== 'disabled' && parsed.sdp !== 'cooling') return null;
    return {
      reason: parsed.sdp,
      until: finiteMs(parsed.until),
      retryAfterMs: finiteMs(parsed.retryAfterMs),
      epoch: finiteEpoch(parsed.epoch),
    };
  } catch {
    return null;
  }
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteEpoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 相对剩余时间优先；绝对 until 必须还在未来。NaN / 过去 / 超过 30min 都不照单全收。 */
export function declineBackoffUntil(detail: DcOfferDeclineExtra, now: number): number | null {
  const until = unclampedDeclineUntil(detail, now);
  if (until == null) return null;
  return Math.min(until, now + RTC_DECLINE_BACKOFF_CAP_MS);
}

function unclampedDeclineUntil(detail: DcOfferDeclineExtra, now: number): number | null {
  const retry = detail.retryAfterMs;
  if (typeof retry === 'number' && Number.isFinite(retry) && retry > 0) return now + retry;
  const abs = detail.until;
  if (typeof abs === 'number' && Number.isFinite(abs) && abs > now) return abs;
  return null;
}

export class DcDeclinedError extends Error {
  readonly reason: DcOfferDeclineReason;
  readonly until: number | null;
  readonly retryAfterMs: number | null;
  readonly epoch: number | null;

  constructor(detail: DcOfferDeclineDetail) {
    super('dc-declined');
    this.name = 'DcDeclinedError';
    this.reason = detail.reason;
    this.until = detail.until;
    this.retryAfterMs = detail.retryAfterMs;
    this.epoch = detail.epoch;
  }
}

export function dcDeclineNoticeOf(err: unknown): DcOfferDeclineDetail | null {
  if (err instanceof DcDeclinedError) {
    return {
      reason: err.reason,
      until: err.until,
      retryAfterMs: err.retryAfterMs,
      epoch: err.epoch,
    };
  }
  return null;
}

/**
 * true：应答侧 superseded 还在预算内，拨号循环再试一次。
 * decline 已经是 DcDeclinedError，调用方原样抛出，不再经全局 map 二次解释。
 */
export function retrySupersededDial(
  _peer: string,
  err: unknown,
  deadline: number,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted || err instanceof DcDeclinedError) return false;
  if (isSupersededDcLoss(err)) return performance.now() < deadline;
  return false;
}

export function isDcOfferDecline(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return parsed.type === DC_OFFER_DECLINE_TYPE;
  } catch {
    return false;
  }
}

/**
 * 新 offerer：decline 立刻收束（不等 15s datachannel open）。
 * 旧 offerer 没有这个分支，未知 type 等价于 ignore。
 */
export function offererReactionToRemoteSdp(raw: string): OffererSdpReaction {
  if (isDcOfferDecline(raw)) return 'abort-now';
  const decoded = decodeSdpSignal(raw);
  if (decoded?.type === 'answer') return 'apply-answer';
  return 'ignore';
}

/** 新 offerer 在 apply 前调用：decline 同步 abort，不等 datachannel open 预算。 */
export function consumeOffererOnDecline(raw: string, abort: () => void): boolean {
  if (offererReactionToRemoteSdp(raw) !== 'abort-now') return false;
  abort();
  return true;
}

export function dcOfferDeclineCtl(opts: {
  rtcSession: string;
  to: string;
  reason: DcOfferDeclineReason;
  until?: number | null;
  retryAfterMs?: number | null;
  epoch?: number | null;
}): {
  t: 'rtc.signal';
  rtcSession: string;
  from: 'node';
  to: string;
  sdp: string;
} {
  return {
    t: 'rtc.signal',
    rtcSession: opts.rtcSession,
    from: 'node',
    to: opts.to,
    sdp: encodeDcOfferDecline(opts.reason, {
      until: opts.until,
      retryAfterMs: opts.retryAfterMs,
      epoch: opts.epoch,
    }),
  };
}
