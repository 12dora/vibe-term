import { wsBorsh } from '@tmex/shared';

/**
 * canonical v1.1 版本门槛（fail-closed）：低于 CANONICAL_V11_MIN_PEER_VERSION 的对端无法正确消费
 * ResizePaneV11 的尺寸语义与 metadata 里的设备树顺序，直接拒绝，不回退 legacy 状态流。
 * ws-borsh 没有独立的「版本过旧」错误码（错误码表在 packages/shared，本任务不改），
 * 因此复用 ERROR_UNSUPPORTED_PROTOCOL，message 由共享模块拼装，前端按同一契约解析出
 * 「谁太旧 + 版本」，两边不会格式漂移。
 */
export const ERROR_CANONICAL_V11_REQUIRED = wsBorsh.ERROR_UNSUPPORTED_PROTOCOL;
export const CANONICAL_V11_REQUIRED_PREFIX = wsBorsh.CANONICAL_V11_REQUIRED_ERROR_PREFIX;

export function clientTooOldMessage(clientVersion: string | null): string {
  return wsBorsh.formatCanonicalV11RequiredError({ side: 'client', version: clientVersion });
}

/** 节点编号必须写进 message：浏览器无从得知转发流对端是哪个节点。 */
export function peerNodeTooOldMessage(nodeId: string | null, peerVersion: string | null): string {
  return wsBorsh.formatCanonicalV11RequiredError({
    side: 'node',
    nodeId,
    version: peerVersion,
  });
}
