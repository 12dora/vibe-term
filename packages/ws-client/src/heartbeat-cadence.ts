// 心跳节奏推导：前后台两套基准 + 服务端协商间隔的合成规则。
// 纯函数，与连接状态无关，便于单独覆盖各分支（client.ts 只负责喂当前上下文）。

import type { HeartbeatCadence } from './heartbeat-controller';

export interface HeartbeatCadenceInput {
  /** 页面是否在后台；非浏览器宿主一律按前台快节奏，避免误判 */
  hidden: boolean;
  intervalMs: number;
  timeoutMs: number;
  hiddenIntervalMs: number;
  hiddenTimeoutMs: number;
  /** 调用方显式给的 pongTimeoutMs：绝对上限，不随协商间隔放大 */
  explicitTimeoutMs: number | undefined;
  /** 服务端协商到的心跳间隔；未协商为 null */
  negotiatedIntervalMs: number | null;
}

export function resolveHeartbeatCadence(input: HeartbeatCadenceInput): HeartbeatCadence {
  if (input.hidden) {
    return { intervalMs: input.hiddenIntervalMs, pongTimeoutMs: input.hiddenTimeoutMs };
  }
  const negotiated = input.negotiatedIntervalMs;
  if (negotiated === null || negotiated === input.intervalMs) {
    return { intervalMs: input.intervalMs, pongTimeoutMs: input.timeoutMs };
  }
  // 缺省超时按 timeout/interval 比值（2×）跟随协商间隔：15s ping ⇒ 30s timeout，
  // 仍远在外部代理（Cloudflare Tunnel 约 100s）的空闲预算内。
  if (input.explicitTimeoutMs !== undefined) {
    return { intervalMs: negotiated, pongTimeoutMs: input.explicitTimeoutMs };
  }
  const ratio = input.intervalMs > 0 ? input.timeoutMs / input.intervalMs : 2;
  return { intervalMs: negotiated, pongTimeoutMs: Math.round(negotiated * ratio) };
}
