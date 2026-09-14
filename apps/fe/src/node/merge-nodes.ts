// 节点表的合并视图：`GET /api/mesh/nodes` 成员集 + `pendingMemberIds` 占位行。
//
// 从 `mesh-nodes.ts` 拆出来的纯函数段（store 与轮询留在原文件）：这里只有输入输出确定的映射，
// 没有任何请求与订阅，测试可以直接喂两个数组。

import { SELF_NODE_ID } from '@vibeterm/api-client';
import type { MeshNode, MeshNodeReach, MeshNodeTransport } from '@vibeterm/api-client/auth/index';
import type { MeshNodeOperation } from '@vibeterm/shared';
import { bytesToHex, decodeBase64url, sha256 } from '@vibeterm/shared/auth';
import { deriveNodeAddress } from './node-address';
import { relayPresenceOf, viaRelayOf } from './relay-extras';

/** 公钥指纹：sha256(pk) 的前 16 个十六进制字符（8 字节）。畸形 base64url 返回空串。 */
export function publicKeyFingerprint(publicKeyB64url: string): string {
  try {
    return bytesToHex(sha256(decodeBase64url(publicKeyB64url))).slice(0, 16);
  } catch {
    return '';
  }
}

/** mesh 列表里的 node id → 运行时 / 路由用的 nodeId（entry 自身退化成 `self`，保持旧路由）。 */
export function toRuntimeNodeId(nodeId: string, entryNodeId: string | null): string {
  return entryNodeId && nodeId === entryNodeId ? SELF_NODE_ID : nodeId;
}

/**
 * entry 自身排第一，其余按名称排序（在线优先）。
 *
 * store 里的 `nodes` 保持 `/api/mesh/nodes` 的原始顺序（NODE_EVENT 投影也只就地改字段），
 * 展示顺序一律由消费方现算：设置页经 `mergeNodes`，侧边栏经 `toSidebarEntries`，
 * 两处都走这个函数，缺省顺序才不会两边不一致。
 */
export function sortNodes(nodes: MeshNode[], entryNodeId: string | null): MeshNode[] {
  return [...nodes].sort((a, b) => {
    const aSelf = entryNodeId != null && a.id === entryNodeId;
    const bSelf = entryNodeId != null && b.id === entryNodeId;
    if (aSelf !== bSelf) return aSelf ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return compareNames(a.name, b.name);
  });
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 合并后的一行：mesh 视图（在线/到达/登录）+ 待同步占位。 */
export interface NodeRow {
  id: string;
  /** 路由 / 运行时用的 id：entry 自身为 `self`。 */
  runtimeNodeId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  online: boolean;
  reach: MeshNodeReach;
  /** peer link 的实际承载；未知为 `null`。 */
  transport: MeshNodeTransport;
  /** entry ↔ node 的 ping/pong 往返毫秒数；未测得为 `null`。 */
  rttMs: number | null;
  /** `transport === 'relay'` 时这条链路走的那台中继；其余情况（含旧网关）为 `null`。 */
  viaRelay?: string | null;
  /** 该对端当前在线的全部中继；旧网关为空数组。 */
  relayPresence?: string[];
  /** 当前链路的对端地址；未知或 self 为 `null`。 */
  peerAddress?: string | null;
  /** 对端广播的 ws 接入地址；self / pending 为空数组。 */
  endpoints?: string[];
  /**
   * 展示用地址（host[:port]）。`mergeNodes` 恒填；手写夹具可缺省，表里按 '—' 渲染。
   */
  address?: string;
  version: string | null;
  directCapable: boolean;
  loggedIn: boolean;
  inventory: unknown;
  isSelf: boolean;
  /** mesh `lastSeenAt`（peer_cache）；没有为 `null`。 */
  lastSeenAt: number | null;
  status: string | null;
  certificate: string | null;
  certSig: string | null;
  /**
   * 入口记录的进行中长事务（远程卸载）；`mergeNodes` 恒填，缺省为 `null`。
   * 声明成可选是为了不逼着每个手写 `NodeRow` 的测试夹具补这一项。
   */
  operation?: MeshNodeOperation | null;
  /** 待同步占位行。 */
  pending?: boolean;
  /**
   * entry 本机偏好：暂停后不再向该成员发起用户面连接，聚合列表（侧栏 / 设备页 / 弹窗）
   * 把它藏起来；管理表仍显示。缺省 / self / pending 视为未暂停。
   */
  paused?: boolean;
}

/** entry 本机偏好；缺省、旧网关、self 一律视为未暂停。 */
export function isMeshNodePaused(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  return (node as { paused?: unknown }).paused === true;
}

function reachOf(reach: string | null | undefined): MeshNodeReach {
  return reach === 'lan' || reach === 'wan' || reach === 'relay' ? reach : null;
}

function transportOf(transport: string | null | undefined): MeshNodeTransport {
  return transport === 'ws-secure' || transport === 'relay' || transport === 'dc'
    ? transport
    : null;
}

function rttOf(rttMs: number | null | undefined): number | null {
  return typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
}

export interface MergeContext {
  entryNodeId: string | null;
  /** 已 admit、状态块还没解开的成员 id；不在 mesh 列表里的补占位行。 */
  pendingMemberIds?: readonly string[] | null;
  /** 本机 HTTPS / 域名；仅 self 行使用。 */
  selfAddress?: string | null;
}

/**
 * 合并 mesh 列表与待同步占位。mesh 列表是**已接纳成员**的权威集。
 *
 * `pendingMemberIds` 里还不在 mesh 列表的 id 补一行占位：已 admit 但名字 / inventory
 * 仍为空（状态块未解开），不列出来用户会以为「只有本机」。
 */
export function mergeNodes(meshNodes: MeshNode[], context: MergeContext): NodeRow[] {
  const admitted = sortNodes(meshNodes, context.entryNodeId).map((node) =>
    toAdmittedRow(node, context)
  );
  const meshIds = new Set(meshNodes.map((node) => node.id));
  return [...admitted, ...pendingRows(context.pendingMemberIds, meshIds)];
}

function toAdmittedRow(node: MeshNode, context: MergeContext): NodeRow {
  const isSelf = isEntryNode(node.id, context);
  const path = admittedPath(node);
  return {
    id: node.id,
    runtimeNodeId: toRuntimeNodeId(node.id, context.entryNodeId),
    name: node.name,
    publicKey: node.publicKey,
    fingerprint: publicKeyFingerprint(node.publicKey),
    online: node.online,
    reach: reachOf(node.reach),
    ...path,
    address: admittedAddress(context, isSelf, path),
    version: node.version ?? null,
    directCapable: node.direct_capable,
    loggedIn: node.loggedIn,
    inventory: node.inventory ?? null,
    isSelf,
    operation: node.operation ?? null,
    lastSeenAt: typeof node.lastSeenAt === 'number' ? node.lastSeenAt : null,
    status: null,
    certificate: null,
    certSig: null,
    pending: false,
    paused: isMeshNodePaused(node) ? true : undefined,
  };
}

function admittedPath(node: MeshNode) {
  return {
    transport: transportOf(node.transport),
    rttMs: rttOf(node.rttMs),
    viaRelay: viaRelayOf(node.viaRelay),
    relayPresence: relayPresenceOf(node.relayPresence),
    peerAddress: node.peerAddress ?? null,
    endpoints: stringList(node.endpoints),
  };
}

function admittedAddress(
  context: MergeContext,
  isSelf: boolean,
  path: ReturnType<typeof admittedPath>
): string {
  return (
    deriveNodeAddress({
      isSelf,
      transport: path.transport,
      peerAddress: path.peerAddress,
      endpoints: path.endpoints,
      viaRelay: path.viaRelay,
      relayPresence: path.relayPresence,
      selfAddress: isSelf ? (context.selfAddress ?? null) : null,
    }) ?? '—'
  );
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function isEntryNode(nodeId: string, context: MergeContext): boolean {
  return context.entryNodeId != null && nodeId === context.entryNodeId;
}

/**
 * `pendingMemberIds` 里还不在 mesh 列表的占位行。
 * 同 ID 只保留第一条：异常 / 过渡期的响应里出现两条同 ID 时，
 * 渲染出重复 React key 会让 busy 状态串行复用。
 */
function pendingRows(
  pendingMemberIds: readonly string[] | null | undefined,
  meshIds: ReadonlySet<string>
): NodeRow[] {
  const seen = new Set<string>();
  const rows: NodeRow[] = [];
  for (const id of pendingMemberIds ?? []) {
    if (!id || meshIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push(toPendingRow(id));
  }
  return rows.sort((a, b) => compareNames(a.name, b.name));
}

function toPendingRow(id: string): NodeRow {
  return {
    id,
    runtimeNodeId: id,
    name: id.slice(0, 8),
    publicKey: '',
    fingerprint: '',
    online: false,
    reach: null,
    transport: null,
    rttMs: null,
    viaRelay: null,
    relayPresence: [],
    peerAddress: null,
    endpoints: [],
    address: '—',
    version: null,
    directCapable: false,
    loggedIn: false,
    inventory: null,
    isSelf: false,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    operation: null,
    pending: true,
  };
}
