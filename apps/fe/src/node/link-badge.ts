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

/** 到这个数就变色。 */
const HIGH_LATENCY_MS = 200;

export interface LinkBadgeDescriptor {
  labelKey: string;
  /** 浏览器 → tmux 宿主的合计往返毫秒数；未测得为 `null`，此时徽标不带延迟后缀。 */
  rttMs: number | null;
  tone: 'ok' | 'muted' | 'warn';
}

/**
 * 宿主一跳的过期线：网关每 15 s 至少播一次，连丢三次就当它不再上报——网关停播与设备静默
 * 掉线都不会有 `device-disconnected`，只能靠「上一帧是什么时候到的」自己判。
 *
 * 判的是 `receivedAt`（收到帧时本地盖的章）而不是 `sampledAt`（网关时钟）：两端时钟未必对齐，
 * 拿网关时刻减浏览器时刻，会把时钟慢几分钟的节点永远判成「已停止上报」。
 */
export const HOST_HOP_STALE_MS = 45_000;

/** 仍在上报的宿主一跳；过期或没有则为 `null`。 */
export function freshHostHop(latency: NodeLatency, now: number): NodeLatency['hostHop'] {
  const sample = latency.hostHop;
  if (!sample) return null;
  return hostHopExpiryDelayMs(sample.receivedAt, now) === 0 ? null : sample;
}

/**
 * 距离这一跳被判过期还有多久；已经过期为 `0`。返回 `null` 表示这个时刻永远不会到来
 * （没有到达时刻、或它不可信），调用方据此不必安排任何定时器。
 */
export function hostHopExpiryDelayMs(receivedAt: number | null, now: number): number | null {
  if (receivedAt === null || !Number.isFinite(receivedAt) || receivedAt <= 0) return null;
  return Math.max(0, receivedAt + HOST_HOP_STALE_MS - now);
}

/** 合计 = 浏览器 → node + node → tmux；宿主一跳测不到（旧节点、没采到、已过期）就只算前半段。 */
export function totalLatencyMs(latency: NodeLatency, now: number = Date.now()): number | null {
  const browser = finiteRtt(latency.browserToNodeMs);
  if (browser == null) return null;
  return browser + (finiteRtt(freshHostHop(latency, now)?.rttMs ?? null) ?? 0);
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
  /** 判断宿主一跳是否过期的基准时刻；缺省取当前时间。 */
  now?: number;
}): LinkBadgeDescriptor {
  const isSelf = input.isSelf === true;
  const reach = input.link.reach;
  const total = totalLatencyMs(input.latency, input.now ?? Date.now());
  // 到达路径还没拿到（节点列表未加载、或该节点已不在列表里）时不带数字：标签写着「不可达」
  // 却挂个毫秒数自相矛盾，宁可只留标签。
  const rttMs = !isSelf && input.path !== 'direct' && reach === null ? null : total;
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
