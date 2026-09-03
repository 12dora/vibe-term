// canonical v1.1 的对端版本门槛。legacy state stream 删除后，v1.1 语义（ResizePaneV11、
// metadata 里的 tree order）是唯一通路，因此判定必须 fail-closed：拿不到版本或版本无法解析
// 一律视为不支持，宁可拒绝建 canonical 会话，也不要在对端静默丢帧。
//
// 唯一例外是开发态自报的 `X.Y.Z_dev`（见 formatDisplayVersion）：去掉后缀后按数字部分比较，
// 否则本地开发的网关与前端永远互相判定为不支持。

import { compareSemver } from '../semver';
import { ERROR_UNSUPPORTED_PROTOCOL } from './errors';

export const CANONICAL_V11_MIN_PEER_VERSION = '1.1.22';

const DEV_SUFFIX = '_dev';

export function peerSupportsCanonicalV11(version: string | null): boolean {
  if (version === null) return false;
  const trimmed = version.trim();
  const base = trimmed.endsWith(DEV_SUFFIX) ? trimmed.slice(0, -DEV_SUFFIX.length) : trimmed;
  const ordering = compareSemver(base, CANONICAL_V11_MIN_PEER_VERSION);
  return ordering !== null && ordering >= 0;
}

/**
 * 网关拒绝低于门槛的对端时，没有独立错误码可用（错误码表已冻结），只能复用
 * ERROR_UNSUPPORTED_PROTOCOL 并在 message 前缀里带上这串固定文本。前缀即契约：
 * 网关按此拼 message，客户端按此把 ERROR 帧翻成 `server-too-old`，两边都从这里取。
 */
export const CANONICAL_V11_REQUIRED_ERROR_PREFIX = 'canonical-state-v1.1 required';

/** 该 ERROR 帧是不是「对端版本低于 canonical v1.1 门槛」——不可重试，调用方应停止自动重连。 */
export function isCanonicalV11RequiredError(code: number, message: string): boolean {
  return (
    code === ERROR_UNSUPPORTED_PROTOCOL && message.startsWith(CANONICAL_V11_REQUIRED_ERROR_PREFIX)
  );
}
