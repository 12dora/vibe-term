// 协议级不可重试错误识别：网关按 canonical v1.1 版本门拒绝本端时回的那条 ERROR。
// 重连只会原样再被拒一次，因此客户端收到后要就地熄火，等宿主升级或调用方显式重连。

import { wsBorsh } from '@tmex/shared';

export function isProtocolFatalError(kind: number, payload: Uint8Array): boolean {
  if (kind !== wsBorsh.KIND_ERROR) return false;
  try {
    const decoded = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, payload);
    return wsBorsh.isCanonicalV11RequiredError(decoded.code, decoded.message);
  } catch {
    // 解不开的 ERROR 帧按普通错误处理，交给下游 handler
    return false;
  }
}
