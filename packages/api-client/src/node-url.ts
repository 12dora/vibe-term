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

/** client nonce 的字节数：合约要求 ≥ 16 字节的 b64url。 */
export const CLIENT_NONCE_BYTES = 16;

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0b111111];
  }
  return out;
}

/**
 * 浏览器为**每条 Gateway WS** 生成的 client nonce（合约里的 `cid`）。
 *
 * 浏览器既不能给 `new WebSocket(url)` 设请求头，也读不到 upgrade 响应头，所以握手上唯一能
 * 携带的自定义信息就是 query。node 拿它当索引**自己生成** `connectionId`，浏览器随后用
 * `GET /api/mesh/connection?cid=` 换回那个服务端 id。**nonce 不是 connectionId**，
 * 绝不能直接拿去 `POST /api/rtc/authorize`。
 */
export function generateClientNonce(): string {
  const bytes = new Uint8Array(CLIENT_NONCE_BYTES);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return base64Url(bytes);
}

export interface NodeWsUrlOptions extends Partial<WsUrlLocation> {
  /** 本条 WS 的 client nonce，拼成 `?cid=`；空值不拼。 */
  cid?: string | null;
}

/**
 * 目标 node 的绝对 ws(s) URL；缺省按当前页面推导（与 ws-client 的 defaultWsUrl 同规则），
 * self → `/ws`，其余 → `/n/<id>/ws`。带 `cid` 时追加 `?cid=<nonce>`。
 */
export function nodeWsUrl(nodeId: string | null | undefined, options?: NodeWsUrlOptions): string {
  const path = resolveNodeUrl(nodeId, '/ws');
  const explicit = options?.protocol !== undefined || options?.host !== undefined;
  const loc = explicit
    ? { protocol: options?.protocol ?? '', host: options?.host ?? '' }
    : typeof window !== 'undefined'
      ? window.location
      : { protocol: '', host: '' };
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = options?.cid ? `?cid=${encodeURIComponent(options.cid)}` : '';
  return `${scheme}//${loc.host}${path}${query}`;
}

/**
 * 一个 `GatewayConnection` 的 ws URL 来源：**每建一条 socket 换一个 nonce**。
 *
 * `BorshWebSocketClient` 重连时复用 `options.url` 字符串，所以 nonce 的轮换只能挂在建 socket
 * 这一步（`GatewayConnectionOptions.wsUrlFactory`）。合约要求每条 WS 一个新 nonce：node 侧
 * `{sid, via}` 作用域内 nonce 冲突会把新 WS 直接 RST，而旧连接的关闭在经 hub 转发时未必先到。
 */
export interface NodeWsUrlSource {
  /** 建新 socket（含重连）时调用：换一个 nonce，返回带 `?cid=` 的 URL。 */
  nextUrl(): string;
  /** 当前 socket 携带的 nonce；还没建过 socket 时为 `null`。 */
  cid(): string | null;
}

export function createNodeWsUrlSource(
  nodeId: string | null | undefined,
  location?: WsUrlLocation
): NodeWsUrlSource {
  let current: string | null = null;
  return {
    nextUrl() {
      current = generateClientNonce();
      return nodeWsUrl(nodeId, { ...location, cid: current });
    },
    cid() {
      return current;
    },
  };
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
