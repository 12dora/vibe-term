// node 感知的 URL 解析：浏览器只连 entry node，访问其它 node 一律经 /n/<nodeId> 前缀
// （`/n/:id/api/...`、`/n/:id/ws`）。nodeId 为 `self` 时等价于 entry 自身，路径保持原样，
// 与旧路由完全一致。所有直接进入 DOM / WebSocket 的 gateway URL 必须经过本模块。

import { ApiClient } from './client';

export const SELF_NODE_ID = 'self';

/** 空、undefined 与 `self` 一律视为 entry 自身。 */
export function isSelfNode(nodeId: string | null | undefined): boolean {
  return !nodeId || nodeId === SELF_NODE_ID;
}

/** 路由/URL 参数归一：缺省即 `self`。 */
export function normalizeNodeId(nodeId: string | null | undefined): string {
  return isSelfNode(nodeId) ? SELF_NODE_ID : (nodeId as string);
}

/** node 路径前缀：self 为空串，其余为 `/n/<encoded id>`（不以 `/` 结尾，可直接做 ApiClient baseUrl）。 */
export function nodePathPrefix(nodeId: string | null | undefined): string {
  return isSelfNode(nodeId) ? '' : `/n/${encodeURIComponent(nodeId as string)}`;
}

/**
 * 把 entry-local 路径解析为目标 node 的路径。
 * path 必须以 `/` 开头；传空串则只取前缀（用于构造 ApiClient baseUrl）。
 */
export function resolveNodeUrl(nodeId: string | null | undefined, path: string): string {
  return isSelfNode(nodeId) ? path : `${nodePathPrefix(nodeId)}${path}`;
}

export interface WsUrlLocation {
  protocol: string;
  host: string;
}

/**
 * 目标 node 的绝对 ws(s) URL；缺省按当前页面推导（与 ws-client 的 defaultWsUrl 同规则），
 * self → `/ws`，其余 → `/n/<id>/ws`。
 */
export function nodeWsUrl(nodeId: string | null | undefined, location?: WsUrlLocation): string {
  const loc =
    location ?? (typeof window !== 'undefined' ? window.location : { protocol: '', host: '' });
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${resolveNodeUrl(nodeId, '/ws')}`;
}

/** 目标 node 的 REST 客户端：baseUrl 即 node 前缀，端点函数照旧传相对 `/api/...`。 */
export function createNodeApiClient(nodeId: string | null | undefined): ApiClient {
  return new ApiClient(nodePathPrefix(nodeId));
}

/**
 * 应用内 SPA 路径的 node 前缀（`/devices/...` → `/n/<id>/devices/...`）。
 * 与 gateway URL 同形，但语义不同：这里是前端路由，经 HostServices.appPath 生效。
 */
export function nodeAppPath(nodeId: string | null | undefined, path: string): string {
  return resolveNodeUrl(nodeId, path);
}

/** 从 pathname 解析 `/n/:nodeId` 前缀；无前缀即 `self`。 */
export function parseNodeIdFromPath(pathname: string): string {
  const match = /^\/n\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return SELF_NODE_ID;
  return normalizeNodeId(decodeURIComponent(match[1]));
}
