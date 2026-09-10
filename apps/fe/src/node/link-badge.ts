// 链路徽标的语义层：这条链路怎么走（到达路径 / 承载 / 明细种类）、有多快（两段延迟合计）
// 与显示时的口径。纯函数，不碰 React，供徽标组件与浮层共用。

import type { MeshNodeReach, MeshNodeTransport } from '@vibeterm/api-client/auth/index';
import type { DirectCarrierPath } from '@vibeterm/ws-client/direct/types';
import type { NodeLatency, NodeLink } from './direct-diagnostics';

const REACH_LABEL_KEYS = {
  lan: 'nodes.reach.lan',
  wan: 'nodes.reach.wan',
  relay: 'nodes.reach.relay',
} as const;

const TRANSPORT_LABEL_KEYS = {
  'ws-secure': 'nodes.badge.transportWs',
  dc: 'nodes.badge.transportDc',
  relay: 'nodes.badge.transportRelay',
} as const;

export function reachLabelKey(reach: MeshNodeReach): string {
  return reach ? REACH_LABEL_KEYS[reach] : 'nodes.reach.none';
}

export function transportLabelKey(transport: MeshNodeTransport): string | null {
  return transport ? TRANSPORT_LABEL_KEYS[transport] : null;
}

/** 与侧栏延迟徽标同一条线：到这个数就变色。 */
const HIGH_LATENCY_MS = 200;

export interface LinkBadgeDescriptor {
  labelKey: string;
  /** 浏览器 → tmux 宿主的合计往返毫秒数；未测得为 `null`，此时徽标不带延迟后缀。 */
  rttMs: number | null;
  tone: 'ok' | 'muted' | 'warn';
}

/** 合计 = 浏览器 → node + node → tmux；宿主一跳测不到（旧节点、还没采到）就只算前半段。 */
export function totalLatencyMs(latency: NodeLatency): number | null {
  const browser = finiteRtt(latency.browserToNodeMs);
  if (browser == null) return null;
  return browser + (finiteRtt(latency.hostHop?.rttMs ?? null) ?? 0);
}

/**
 * 徽标取值。数字是整条链路的往返，标签只说这条链路怎么走：本机 / 直连 / 局域网 / 公网 /
 * 中转。心跳还没出第一个样本时不带后缀——写「延迟未知」只会让人以为链路出了问题。
 */
export function resolveLinkBadge(input: {
  path: DirectCarrierPath;
  link: NodeLink;
  latency: NodeLatency;
  /** 本机（entry 自身）：浏览器直接连的就是它，没有第二跳。 */
  isSelf?: boolean;
}): LinkBadgeDescriptor {
  const isSelf = input.isSelf === true;
  const reach = input.link.reach;
  const rttMs = totalLatencyMs(input.latency);
  return {
    labelKey: badgeLabelKey(isSelf, input.path, reach),
    rttMs,
    tone: badgeTone(rttMs, isSelf, input.path, reach),
  };
}

function badgeLabelKey(isSelf: boolean, path: DirectCarrierPath, reach: MeshNodeReach): string {
  if (isSelf) return 'nodes.badge.local';
  if (path === 'direct') return 'nodes.badge.direct';
  return reachLabelKey(reach);
}

function badgeTone(
  rttMs: number | null,
  isSelf: boolean,
  path: DirectCarrierPath,
  reach: MeshNodeReach
): LinkBadgeDescriptor['tone'] {
  if (rttMs !== null && rttMs >= HIGH_LATENCY_MS) return 'warn';
  if (isSelf || path === 'direct' || reach === 'lan' || reach === 'wan') return 'ok';
  return 'muted';
}

export function formatLinkBadgeLabel(label: string, rttMs: number | null): string {
  return rttMs == null ? label : `${label} · ${Math.round(rttMs)}ms`;
}

/** 负数 / NaN / 缺失一律当作未测得。 */
export function finiteRtt(rttMs: number | null): number | null {
  return typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
}

/**
 * 明细要按哪种链路来列。`browser-direct` 是浏览器 ↔ node 的 WebRTC，其余取 entry ↔ node
 * 的承载——两者是不同的两跳，只有前者手上有 ICE 明细。
 */
export type LinkDetailKind = 'browser-direct' | 'dc' | 'ws-secure' | 'relay' | 'none';

export function linkDetailKind(
  path: DirectCarrierPath,
  transport: MeshNodeTransport
): LinkDetailKind {
  if (path === 'direct') return 'browser-direct';
  if (transport === 'relay') return 'relay';
  if (transport === 'ws-secure') return 'ws-secure';
  if (transport === 'dc') return 'dc';
  return 'none';
}
