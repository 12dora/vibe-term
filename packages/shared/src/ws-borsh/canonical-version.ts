// canonical v1.1 的对端版本门槛。legacy state stream 删除后，v1.1 语义（ResizePaneV11、
// metadata 里的 tree order）是唯一通路，因此判定必须 fail-closed：拿不到版本或版本无法解析
// 一律视为不支持，宁可拒绝建 canonical 会话，也不要在对端静默丢帧。
//
// 唯一例外是开发态自报的 `X.Y.Z_dev`（见 formatDisplayVersion）：去掉后缀后按数字部分比较，
// 否则本地开发的网关与前端永远互相判定为不支持。

import { compareSemver } from '../semver';

export const CANONICAL_V11_MIN_PEER_VERSION = '1.1.22';

const DEV_SUFFIX = '_dev';

export function peerSupportsCanonicalV11(version: string | null): boolean {
  if (version === null) return false;
  const trimmed = version.trim();
  const base = trimmed.endsWith(DEV_SUFFIX) ? trimmed.slice(0, -DEV_SUFFIX.length) : trimmed;
  const ordering = compareSemver(base, CANONICAL_V11_MIN_PEER_VERSION);
  return ordering !== null && ordering >= 0;
}
