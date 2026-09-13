import type { RtcSignalMessage } from './mesh-deps';
import type { LivePeer } from './peer-reconnect-wake';
import type { RtcSignalInboxEntry } from './peer-rtc-wake';

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
  if (!input.answererAllows) return 'cooldown';
  return null;
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
