// node 感知的 URL 解析：浏览器只连 entry node，访问其它 node 一律经 /n/<nodeId> 前缀
// （`/n/:id/api/...`、`/n/:id/ws`）。nodeId 为 `self` 时等价于 entry 自身，路径保持原样，
// 与旧路由完全一致。所有直接进入 DOM / WebSocket 的 gateway URL 必须经过本模块。

import { ApiClient } from './client';

export const SELF_NODE_ID = 'self';

/** node id 的规范形态：16 字节 → 32 位小写十六进制。 */
export const NODE_ID_PATTERN = /^[0-9a-f]{32}$/;

export class InvalidNodeIdError extends Error {
  readonly code = 'INVALID_NODE_ID';
  constructor(readonly nodeId: string) {
    super(`invalid node id: ${nodeId}`);
    this.name = 'InvalidNodeIdError';
  }
}

/** 空、undefined 与 `self` 一律视为 entry 自身。 */
export function isSelfNode(nodeId: string | null | undefined): boolean {
  return !nodeId || nodeId === SELF_NODE_ID;
}

/** 不抛版本：判断是否为可用于拼路径的 node id。 */
export function isValidNodeId(nodeId: string | null | undefined): boolean {
  return isSelfNode(nodeId) || NODE_ID_PATTERN.test(nodeId as string);
}

/**
 * 拼任何 `/n/<id>` 路径前的**唯一**校验入口：只接受 `self` 或规范的 32 位小写 hex。
 *
 * 不能只靠 `encodeURIComponent()`：它不编码 `.`，`nodeId='..'` 会拼出 `/n/../api/x`，
 * URL 规范化后越过目标 node 的路径边界打到 entry 自身（见 F4-1 评审 Major）。
 * 同理 `%2e%2e` 这类已编码串会被再编码成字面量而绕过肉眼检查，一律拒绝。
 */
export function assertNodeId(nodeId: string | null | undefined): string {
  if (isSelfNode(nodeId)) return SELF_NODE_ID;
  const id = nodeId as string;
  if (!NODE_ID_PATTERN.test(id)) throw new InvalidNodeIdError(id);
  return id;
}

/** 路由/URL 参数归一：缺省即 `self`。不校验，仅用于 Map key 等内部归一。 */
export function normalizeNodeId(nodeId: string | null | undefined): string {
  return isSelfNode(nodeId) ? SELF_NODE_ID : (nodeId as string);
}

/** node 路径前缀：self 为空串，其余为 `/n/<id>`（不以 `/` 结尾，可直接做 ApiClient baseUrl）。 */
export function nodePathPrefix(nodeId: string | null | undefined): string {
  const id = assertNodeId(nodeId);
  return id === SELF_NODE_ID ? '' : `/n/${id}`;
}

/**
 * 把 entry-local 路径解析为目标 node 的路径。
 * path 必须以 `/` 开头；传空串则只取前缀（用于构造 ApiClient baseUrl）。
 */
export function resolveNodeUrl(nodeId: string | null | undefined, path: string): string {
  return `${nodePathPrefix(nodeId)}${path}`;
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
  const path = resolveNodeUrl(nodeId, '/ws');
  const loc =
    location ?? (typeof window !== 'undefined' ? window.location : { protocol: '', host: '' });
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${path}`;
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

/** 从 pathname 解析 `/n/:nodeId` 前缀；无前缀或不是规范 node id 一律视为 `self`。 */
export function parseNodeIdFromPath(pathname: string): string {
  const match = /^\/n\/([^/?#]+)(?:[/?#]|$)/.exec(pathname);
  if (!match) return SELF_NODE_ID;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    return SELF_NODE_ID;
  }
  return isValidNodeId(raw) ? normalizeNodeId(raw) : SELF_NODE_ID;
}
