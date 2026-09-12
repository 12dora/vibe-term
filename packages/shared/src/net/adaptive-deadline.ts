/** 按观测延迟放大墙钟上限，夹在 [minMs, maxMs]。`rttMs` 缺失或非正时退化为下限。 */
export function adaptiveDeadlineMs(opts: {
  rttMs: number | null | undefined;
  factor: number;
  minMs: number;
  maxMs: number;
}): number {
  const rtt =
    typeof opts.rttMs === 'number' && Number.isFinite(opts.rttMs) && opts.rttMs > 0
      ? opts.rttMs
      : 0;
  const scaled = rtt * opts.factor;
  return Math.min(opts.maxMs, Math.max(opts.minMs, scaled));
}

/** 从未观测到 RTT 时的拨号代理值（偏保守的跨区下限，不是 LAN）。 */
export const DEFAULT_DIAL_RTT_MS = 800;

const CONNECT_MIN_MS = 3_000;
const CONNECT_MAX_MS = 15_000;
const DIRECT_MIN_MS = 4_000;
const DIRECT_MAX_MS = 12_000;
const FORWARD_MIN_MS = 5_000;
const FORWARD_MAX_MS = 20_000;
const RELAY_HANDSHAKE_MIN_MS = 1_000;
const RELAY_HANDSHAKE_MAX_MS = 8_000;
const FOREGROUND_DC_MIN_MS = 1_000;
const FOREGROUND_DC_MAX_MS = 4_000;
/** 嵌套预算之间至少留出的余量，保证 connect < direct < forward。 */
const NEST_SLACK_MS = 500;

export type NestedDialBudgets = {
  foregroundDcMs: number;
  connectMs: number;
  directMs: number;
  forwardMs: number;
};

function positiveRttMs(rttMs: number | null | undefined): number | null {
  return typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0 ? rttMs : null;
}

/** 拨号用 RTT：有样本用样本，否则 800 ms 跨区代理（不要退回 LAN 下限）。 */
export function dialRttOrProxyMs(rttMs: number | null | undefined): number {
  return positiveRttMs(rttMs) ?? DEFAULT_DIAL_RTT_MS;
}

function nestFromConnect(
  connectMs: number,
  directMs: number,
  handshakeMs: number
): Omit<NestedDialBudgets, 'foregroundDcMs'> {
  const nestedDirect = Math.max(directMs, connectMs + NEST_SLACK_MS);
  let forwardMs = Math.max(FORWARD_MIN_MS, nestedDirect + handshakeMs);
  if (forwardMs <= nestedDirect) forwardMs = nestedDirect + NEST_SLACK_MS;
  return { connectMs, directMs: nestedDirect, forwardMs };
}

function withForegroundDc(
  budgets: Omit<NestedDialBudgets, 'foregroundDcMs'>,
  rtt: number
): NestedDialBudgets {
  const raw = adaptiveDeadlineMs({
    rttMs: rtt,
    factor: 3,
    minMs: FOREGROUND_DC_MIN_MS,
    maxMs: FOREGROUND_DC_MAX_MS,
  });
  return {
    ...budgets,
    foregroundDcMs: Math.min(Math.max(FOREGROUND_DC_MIN_MS, budgets.directMs - NEST_SLACK_MS), raw),
  };
}

/**
 * 嵌套拨号预算：socket ⊂ 直连竞速 ⊂ 转发取链。
 * 无有效样本按 `DEFAULT_DIAL_RTT_MS`（800 ms），不要用 rtt=0 退回 3/4/5 s LAN 档。
 * 公式（各档先独立 clamp，再抬外层 / 压内层，保证 connect < direct < forward）：
 * - socket = clamp(6×RTT, 3 s, 15 s)
 * - direct = clamp(5×RTT, 4 s, 12 s)
 * - DC 独跑 = clamp(3×RTT, 1 s, 4 s)，且至少比 direct 早 500 ms
 * - forward ≥ direct + clamp(2×RTT, 1 s, 8 s)，夹在 5–20 s
 * `connectTimeoutMs` 为调用方显式 socket 超时（可大于自适应值）；此时不再压 connect，只抬外层。
 */
export function nestedDialBudgetsMs(
  rttMs: number | null | undefined,
  connectTimeoutMs?: number | null
): NestedDialBudgets {
  const rtt = dialRttOrProxyMs(rttMs);
  const adaptiveConnect = adaptiveDeadlineMs({
    rttMs: rtt,
    factor: 6,
    minMs: CONNECT_MIN_MS,
    maxMs: CONNECT_MAX_MS,
  });
  const adaptiveDirect = adaptiveDeadlineMs({
    rttMs: rtt,
    factor: 5,
    minMs: DIRECT_MIN_MS,
    maxMs: DIRECT_MAX_MS,
  });
  const handshakeMs = adaptiveDeadlineMs({
    rttMs: rtt,
    factor: 2,
    minMs: RELAY_HANDSHAKE_MIN_MS,
    maxMs: RELAY_HANDSHAKE_MAX_MS,
  });
  if (
    typeof connectTimeoutMs === 'number' &&
    Number.isFinite(connectTimeoutMs) &&
    connectTimeoutMs > 0
  ) {
    return withForegroundDc(nestFromConnect(connectTimeoutMs, adaptiveDirect, handshakeMs), rtt);
  }
  let connectMs = adaptiveConnect;
  let directMs = adaptiveDirect;
  if (directMs < connectMs + NEST_SLACK_MS) {
    directMs = Math.min(DIRECT_MAX_MS, connectMs + NEST_SLACK_MS);
  }
  if (directMs <= connectMs) {
    connectMs = Math.max(CONNECT_MIN_MS, directMs - NEST_SLACK_MS);
  }
  let forwardMs = Math.min(FORWARD_MAX_MS, Math.max(FORWARD_MIN_MS, directMs + handshakeMs));
  if (forwardMs <= directMs) {
    forwardMs = Math.min(FORWARD_MAX_MS, directMs + NEST_SLACK_MS);
  }
  return withForegroundDc({ connectMs, directMs, forwardMs }, rtt);
}
