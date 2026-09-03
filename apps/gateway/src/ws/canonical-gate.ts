import { wsBorsh } from '@tmex/shared';

/**
 * canonical v1.1 版本门槛（fail-closed）：低于 CANONICAL_V11_MIN_PEER_VERSION 的对端无法正确消费
 * ResizePaneV11 的尺寸语义与 metadata 里的设备树顺序，直接拒绝，不回退 legacy 状态流。
 * ws-borsh 没有独立的「版本过旧」错误码（错误码表在 packages/shared，本任务不改），
 * 因此复用 ERROR_UNSUPPORTED_PROTOCOL，用固定 message 前缀让前端区分。
 */
export const ERROR_CANONICAL_V11_REQUIRED = wsBorsh.ERROR_UNSUPPORTED_PROTOCOL;
export const CANONICAL_V11_REQUIRED_PREFIX = 'canonical-state-v1.1 required';

export function clientTooOldMessage(clientVersion: string | null): string {
  return `${CANONICAL_V11_REQUIRED_PREFIX}: client ${clientVersion ?? 'unknown'} < ${wsBorsh.CANONICAL_V11_MIN_PEER_VERSION}`;
}

export function peerNodeTooOldMessage(peerVersion: string | null): string {
  return `${CANONICAL_V11_REQUIRED_PREFIX}: node ${peerVersion ?? 'unknown'} < ${wsBorsh.CANONICAL_V11_MIN_PEER_VERSION}`;
}
