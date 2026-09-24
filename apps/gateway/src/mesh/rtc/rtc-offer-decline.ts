import { decodeSdpSignal } from './ice';
import type { DcOfferBlockReason } from './rtc-dial-breaker';

/** 信令里没有独立的 busy/reject。decline 走现有 rtc.signal SDP：旧对端把未知 type 丢掉，不抛。 */
export const DC_OFFER_DECLINE_TYPE = 'decline';

export type DcOfferDeclineReason = DcOfferBlockReason;

export type OffererSdpReaction = 'apply-answer' | 'abort-now' | 'ignore';

export function encodeDcOfferDecline(reason: DcOfferDeclineReason): string {
  return JSON.stringify({ type: DC_OFFER_DECLINE_TYPE, sdp: reason });
}

export function readDcOfferDecline(raw: string | null | undefined): DcOfferDeclineReason | null {
  if (!isDcOfferDecline(raw) || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { sdp?: unknown };
    if (parsed.sdp === 'disabled' || parsed.sdp === 'cooling') return parsed.sdp;
  } catch {
    return null;
  }
  return null;
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
    sdp: encodeDcOfferDecline(opts.reason),
  };
}
