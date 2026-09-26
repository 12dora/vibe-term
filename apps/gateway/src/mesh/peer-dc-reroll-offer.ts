import type { RtcSignalMessage } from './mesh-deps';
import type { LivePeer } from './peer-reconnect-wake';
import type { RtcSignalInboxEntry } from './peer-rtc-wake';
import { peerRtcSession } from './rtc/ice';
import { rtcLog } from './rtc/rtc-log';
import { dcOfferDeclineCtl } from './rtc/rtc-offer-decline';

export type RerollOfferIgnoreReason =
  | 'epoch'
  | 'inflight'
  | 'budget'
  | 'not-capable'
  | 'inbox-full'
  | 'role'
  | 'cooldown';

export type RerollOfferIgnoreInput = {
  live: LivePeer | undefined;
  offerEpoch: number | undefined;
  inflight: boolean;
  isAnswerer: boolean;
  answererAllows: boolean;
  /** 对端 offer 对应本端仍在结果窗口内的 `link.reroll-request` 时绕过应答冷却。 */
  respondsToOurRequest?: boolean;
};

/**
 * 已是 dc 的重掷 offer 才需要拦截。其它信令交回常规投递（`skip`）。
 * `budget` 留给日志口径；接对端 offer 不再用它做门闩。
 */
export function rerollOfferIgnoreReason(
  input: RerollOfferIgnoreInput
): RerollOfferIgnoreReason | 'skip' | null {
  const { live } = input;
  if (!live || live.transport !== 'dc') return 'skip';
  if (live.rerollCapable !== true) return 'not-capable';
  if (
    live.rtcEpoch !== undefined &&
    input.offerEpoch !== undefined &&
    input.offerEpoch <= live.rtcEpoch
  ) {
    return 'epoch';
  }
  if (input.inflight) return 'inflight';
  if (!input.isAnswerer) return 'role';
  if (!input.answererAllows && !input.respondsToOurRequest) return 'cooldown';
  return null;
}

export function sendRerollDecline(
  send: ((peerNodeId: string, msg: RtcSignalMessage) => void) | undefined,
  selfId: string,
  nodeId: string,
  msg: RtcSignalMessage,
  epoch: number | undefined
): void {
  if (!send) return;
  const ctl = dcOfferDeclineCtl({
    rtcSession: msg.rtcSession || peerRtcSession(selfId, nodeId),
    to: nodeId,
    reason: 'cooling',
    retryAfterMs: 30_000,
    epoch,
  });
  send(nodeId, {
    rtcSession: ctl.rtcSession,
    from: 'node',
    to: ctl.to,
    sdp: ctl.sdp,
    candidate: null,
  });
}

export function consumeIgnoredRerollOffer(
  input: RerollOfferIgnoreInput & {
    send: ((peerNodeId: string, msg: RtcSignalMessage) => void) | undefined;
    selfId: string;
    nodeId: string;
    msg: RtcSignalMessage;
  }
): 'skip' | 'declined' | 'take' {
  const reason = rerollOfferIgnoreReason(input);
  if (reason === 'skip') return 'skip';
  if (!reason) return 'take';
  sendRerollDecline(input.send, input.selfId, input.nodeId, input.msg, input.offerEpoch);
  rtcLog('reroll_offer_ignored', { peer: input.nodeId.slice(0, 8), reason });
  return 'declined';
}

export function dropInboxMessage(
  inbox: Map<string, RtcSignalInboxEntry[]>,
  nodeId: string,
  msg: RtcSignalMessage
): void {
  const rows = inbox.get(nodeId);
  if (!rows) return;
  const next = rows.filter((row) => row.message !== msg);
  if (next.length === 0) inbox.delete(nodeId);
  else inbox.set(nodeId, next);
}
