// 心跳节奏推导：前后台两套基准 + 服务端协商间隔的合成规则。
// 纯函数，与连接状态无关，便于单独覆盖各分支（client.ts 只负责喂当前上下文）。

import type { HeartbeatCadence } from './heartbeat-controller';

// 网关在 HELLO_S2C 里播报 heartbeatIntervalMs（当前 15s）。采纳它能把空闲会话的
// PING/PONG 从 24 次/min 降到 8 次/min；钳位区间保证既不比缺省更吵，也不会因为
// 服务端播报一个离谱值而把死连接检出拖到分钟级。
export const MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS = 5000;
export const MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS = 30000;

/** 服务端播报值归一化：0 / 非有限值视为「未协商」，其余钳到 [5s, 30s]。 */
export function normalizeNegotiatedHeartbeatIntervalMs(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  if (value < MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS) return MIN_NEGOTIATED_HEARTBEAT_INTERVAL_MS;
  if (value > MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS) return MAX_NEGOTIATED_HEARTBEAT_INTERVAL_MS;
  return Math.round(value);
}

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

/** 回前台探测的 PONG 期限 = 心跳 RTT 中位数的倍数。 */
export const RESUME_PROBE_RTT_FACTOR = 4;
/** 期限下限：弱网抖一下就误杀一条好连接，代价远高于多等两秒。 */
export const MIN_RESUME_PROBE_TIMEOUT_MS = 2000;
/** 期限上限：再慢的链路也不该让用户盯着一块不动的终端超过这个数。 */
export const MAX_RESUME_PROBE_TIMEOUT_MS = 6000;

export interface ResumeProbeInput {
  /** 心跳 RTT 中位数；本连接还没测到样本为 null。 */
  medianLatencyMs: number | null;
  /** 当前生效的常规 PONG 期限：探测期限绝不比它更长，否则这次探测毫无意义。 */
  pongTimeoutMs: number;
}

/**
 * 回前台那一次补发 PING 的 PONG 期限。
 *
 * 常规期限跟着服务端协商间隔放大到 30 s（后台 60 s），而 iOS 回前台时链路多半已经是僵尸：
 * 看着还开着、对端早没了。这里改用**实测 RTT** 推期限，把「察觉链路已死」从 30 s 压到秒级；
 * 没有样本（刚连上就切走）时取上限，仍远快于常规期限。
 */
export function resolveResumeProbeTimeoutMs(input: ResumeProbeInput): number {
  const median = input.medianLatencyMs;
  const derived =
    median === null || !Number.isFinite(median) || median <= 0
      ? MAX_RESUME_PROBE_TIMEOUT_MS
      : Math.min(
          MAX_RESUME_PROBE_TIMEOUT_MS,
          Math.max(MIN_RESUME_PROBE_TIMEOUT_MS, Math.round(median * RESUME_PROBE_RTT_FACTOR))
        );
  return Math.min(derived, input.pongTimeoutMs);
}
