// 通知汇聚声明记录 `notification-sink`：由用户的根钥 / passkey 签名，指明某台节点是否为汇聚机。
//
// 汇聚声明原先搭 `node.status` 的 inventory 便车（节点自述），一台被攻陷的节点可以自称汇聚机，
// 把其它节点的事件（含窗格标题、watch 命中文本）全都收到手里。改成密钥日志记录后，
// 判据只剩「用户签过的那一条」，节点自述不再被采信。

import { b } from '@zorsh/zorsh';
import type { KeyLogRecord } from './encoding';
import { nodeIdToHex } from './encoding';
import type { ApplyKeyLogResult, UserKeyState } from './key-log';

/** 字段顺序即 Borsh 编码顺序，改动等于换协议。 */
export const NotificationSinkPayloadSchema = b.struct({
  node_id: b.bytes(16),
  enabled: b.bool(),
  at: b.u64(),
});
export type NotificationSinkPayload = b.infer<typeof NotificationSinkPayloadSchema>;

export function encodeNotificationSinkPayload(value: NotificationSinkPayload): Uint8Array {
  return NotificationSinkPayloadSchema.serialize(value);
}

export function decodeNotificationSinkPayload(bytes: Uint8Array): NotificationSinkPayload {
  return NotificationSinkPayloadSchema.deserialize(bytes);
}

export function buildNotificationSinkPayload(input: {
  nodeId: Uint8Array;
  enabled: boolean;
  at: number | bigint;
}): Uint8Array {
  if (input.nodeId.length !== 16) {
    throw new Error('node id must be 16 bytes');
  }
  const at = typeof input.at === 'bigint' ? input.at : BigInt(Math.trunc(input.at));
  if (at < 0n) {
    throw new Error('invalid timestamp');
  }
  return encodeNotificationSinkPayload({
    node_id: new Uint8Array(input.nodeId),
    enabled: input.enabled,
    at,
  });
}

/** 同一节点多条声明时后写的赢：回放按 seq 递增，直接覆盖即可。 */
export function applyNotificationSink(
  state: UserKeyState,
  record: KeyLogRecord
): ApplyKeyLogResult {
  let payload: NotificationSinkPayload;
  try {
    payload = decodeNotificationSinkPayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  const hex = nodeIdToHex(payload.node_id);
  if (!state.nodeCerts.has(hex)) {
    return { ok: false, error: 'unknown_node' };
  }
  state.notificationSinks ??= new Map();
  state.notificationSinks.set(hex, payload.enabled);
  return { ok: true, state, effects: [] };
}
