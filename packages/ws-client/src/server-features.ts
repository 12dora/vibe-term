// 按 HELLO_S2C.serverVersion 推导的服务端特性判定。
//
// 1.1.7 之前的网关（含 mesh 里尚未升级的远端节点）不认识 KIND_TERM_VIEWPORT，
// 收到就回 ERROR_UNKNOWN_KIND；客户端据此在发送侧静默丢弃，避免每次切 pane 刷一条错误。
// 版本无法解析（开发态的 `1.1.9_dev`、空串等）一律按新版处理，宁可多发不可少发。

import { compareSemver } from '@tmex/shared';

export const TERM_VIEWPORT_MIN_SERVER_VERSION = '1.1.7';

export function serverSupportsTermViewport(serverVersion: string | null): boolean {
  if (serverVersion === null) return true;
  const ordering = compareSemver(serverVersion, TERM_VIEWPORT_MIN_SERVER_VERSION);
  return ordering === null || ordering >= 0;
}
