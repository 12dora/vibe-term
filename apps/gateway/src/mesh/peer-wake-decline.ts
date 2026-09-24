import type { RtcSignalMessage } from './mesh-deps';
import { peerRtcSession } from './rtc/ice';
import type { DcOfferBlockReason, RtcDialBreaker } from './rtc/rtc-dial-breaker';
import { dcOfferDeclineCtl } from './rtc/rtc-offer-decline';

/**
 * 对端 wake 让本端（offerer）拨号。门拒绝时必须把 decline 送回去，
 * 否则对端把 15s 超时记成自己的失败。返回 true 表示这次 wake 已经拒绝。
 */
export function declineIncomingWake(input: {
  breaker: RtcDialBreaker;
  selfId: string;
  fromNodeId: string;
  msg: RtcSignalMessage;
  send: (msg: RtcSignalMessage) => void;
}): boolean {
  const reason = input.breaker.inboundBlock(input.fromNodeId);
  if (!reason || !wakingOfferRefused(reason)) return false;
  const cooldown = input.breaker.refusalCooldown(input.fromNodeId);
  const session = input.msg.rtcSession || peerRtcSession(input.selfId, input.fromNodeId);
  const ctl = dcOfferDeclineCtl({
    rtcSession: session,
    to: input.fromNodeId,
    reason,
    until: cooldown.until,
    retryAfterMs: cooldown.retryAfterMs,
  });
  input.send({
    rtcSession: ctl.rtcSession,
    from: 'node',
    to: ctl.to,
    sdp: ctl.sdp,
  });
  return true;
}

/** 低档冷却仍应答。disabled 和冷却到顶才回 decline。 */
function wakingOfferRefused(reason: DcOfferBlockReason): boolean {
  return reason === 'disabled' || reason === 'cooling';
}
