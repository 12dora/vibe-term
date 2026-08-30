// 从 `RTCPeerConnection.getStats()` 提取选中候选对，并映射成设计 §1 的路径徽标取值。

import type { StatsReportLike } from './rtc-types';

/** 设计 §1「网络路径诊断」：`relay` 指 hub 中转，直连场景不会由 stats 推出。 */
export type DirectRoute = 'lan' | 'v6' | 'v4-p2p' | 'turn' | 'relay';

export interface SelectedPairStats {
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  localAddress: string | null;
  remoteAddress: string | null;
  /** `udp` / `tcp` */
  protocol: string | null;
  /** 往返时延（毫秒）；stats 里是秒。 */
  rttMs: number | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function candidateAddress(report: Record<string, unknown> | undefined): string | null {
  return str(report?.address) ?? str(report?.ip);
}

/**
 * 找出选中的候选对，按可信度从高到低：
 *   1. `transport.selectedCandidatePairId`（[WebRTC Stats] 定义的「当前承载流量的候选对」）
 *   2. `nominated && state === 'succeeded'`
 *   3. 非标准的 `selected === true`（老浏览器）
 *   4. 任意 `succeeded`
 * 顺序不能把第 4 条提到第 3 条前面：兼容性浏览器会同时留着多个 succeeded pair，
 * 取第一条可能显示的是根本没承载流量的候选类型（实际走 TURN 却显示 v4-p2p）。
 *
 * [WebRTC Stats]: https://www.w3.org/TR/webrtc-stats/
 */
export function readSelectedPair(report: StatsReportLike): SelectedPairStats | null {
  const byId = new Map<string, Record<string, unknown>>();
  const pairs: Array<Record<string, unknown>> = [];
  let selectedPairId: string | null = null;

  // biome-ignore lint/complexity/noForEach: RTCStatsReport 只暴露 forEach，没有可迭代协议
  report.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const id = str(entry.id);
    if (id) byId.set(id, entry);
    const type = str(entry.type);
    if (type === 'candidate-pair') pairs.push(entry);
    if (type === 'transport') selectedPairId ??= str(entry.selectedCandidatePairId);
  });

  const pair =
    (selectedPairId ? byId.get(selectedPairId) : undefined) ??
    pairs.find((p) => p.nominated === true && str(p.state) === 'succeeded') ??
    pairs.find((p) => p.selected === true) ??
    pairs.find((p) => str(p.state) === 'succeeded');
  if (!pair) return null;

  const local = byId.get(str(pair.localCandidateId) ?? '');
  const remote = byId.get(str(pair.remoteCandidateId) ?? '');
  const rtt = pair.currentRoundTripTime;

  return {
    localCandidateType: str(local?.candidateType),
    remoteCandidateType: str(remote?.candidateType),
    localAddress: candidateAddress(local),
    remoteAddress: candidateAddress(remote),
    protocol: str(local?.protocol) ?? str(pair.protocol),
    rttMs: typeof rtt === 'number' && Number.isFinite(rtt) ? rtt * 1000 : null,
  };
}

function isIpv6(address: string | null): boolean {
  return address?.includes(':') ?? false;
}

/**
 * 候选对 → 路径徽标：
 * - 任一端 `relay` → `turn`（走了 TURN 服务器）
 * - 两端都是 `host` → 同网段直达：v6 地址显示 `v6`，否则 `lan`
 * - 其余（srflx / prflx 打洞成功）→ `v6` 或 `v4-p2p`
 */
export function deriveRoute(pair: SelectedPairStats | null): DirectRoute | null {
  if (!pair) return null;
  const local = pair.localCandidateType;
  const remote = pair.remoteCandidateType;
  if (local === 'relay' || remote === 'relay') return 'turn';
  if (!local && !remote) return null;
  const v6 = isIpv6(pair.localAddress) || isIpv6(pair.remoteAddress);
  if (local === 'host' && remote === 'host') return v6 ? 'v6' : 'lan';
  return v6 ? 'v6' : 'v4-p2p';
}

/** 诊断浮层里的可读描述，形如 `host → srflx`。 */
export function describePair(pair: SelectedPairStats | null): string | null {
  if (!pair) return null;
  if (!pair.localCandidateType && !pair.remoteCandidateType) return null;
  return `${pair.localCandidateType ?? '?'} → ${pair.remoteCandidateType ?? '?'}`;
}
