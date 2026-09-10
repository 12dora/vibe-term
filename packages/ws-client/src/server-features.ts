// 按 HELLO_S2C 协商结果（serverVersion / capabilities）推导的服务端特性判定。
//
// 1.1.7 之前的网关（含 mesh 里尚未升级的远端节点）不认识 KIND_TERM_VIEWPORT，
// 收到就回 ERROR_UNKNOWN_KIND；客户端据此在发送侧静默丢弃，避免每次切 pane 刷一条错误。
// 版本无法解析（开发态的 `1.1.9_dev`、空串等）一律按新版处理，宁可多发不可少发。

import { GATEWAY_CAPABILITY_DEVICE_LATENCY_V1, compareSemver } from '@vibeterm/shared';

export const TERM_VIEWPORT_MIN_SERVER_VERSION = '1.1.7';

export function serverSupportsTermViewport(serverVersion: string | null): boolean {
  if (serverVersion === null) return true;
  const ordering = compareSemver(serverVersion, TERM_VIEWPORT_MIN_SERVER_VERSION);
  return ordering === null || ordering >= 0;
}

/**
 * 网关是否播报「宿主一跳」（网关 ↔ tmux server）延迟。没播报的旧节点永远不发
 * DEVICE_LATENCY 帧，UI 据此把这一段说成「未测量」而不是当成 0。
 * HELLO 还没协商完（能力集尚不存在）时同样按「未播报」处理。
 */
export function serverSupportsDeviceLatency(capabilities?: readonly string[]): boolean {
  return capabilities?.includes(GATEWAY_CAPABILITY_DEVICE_LATENCY_V1) ?? false;
}
