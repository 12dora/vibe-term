// 节点表的合并视图：`GET /api/mesh/nodes`（成员集）+ `GET /n/<hub>/api/hub/nodes`（心跳 / 接纳态）。
//
// 从 `mesh-nodes.ts` 拆出来的纯函数段（store 与轮询留在原文件）：这里只有输入输出确定的映射，
// 没有任何请求与订阅，测试可以直接喂两个数组。

import { SELF_NODE_ID } from '@tmex/api-client';
import type {
  HubMode,
  MeshNode,
  MeshNodeReach,
  MeshNodeTransport,
} from '@tmex/api-client/auth/index';
import type { MeshNodeOperation } from '@tmex/shared';
import { bytesToHex, decodeBase64url, sha256 } from '@tmex/shared/auth';
import { type HubAdmissionStatus, type HubNodeRow, hubAdmissionStatus } from './hub-api';

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

/** 签一条 `admit-node` 所需的全套材料（都是 base64url，且都不是秘密）。 */
export interface PendingAdmitMaterial {
  enrollmentId: string;
  authorization: string;
  authorizationSig: string;
  certificate: string;
  certSig: string;
}

/** 合并后的一行：mesh 视图（在线/到达/登录）+ hub 视图（心跳、状态、证书）。 */
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
  version: string | null;
  directCapable: boolean;
  loggedIn: boolean;
  inventory: unknown;
  isSelf: boolean;
  isHub: boolean;
  /** hub 机的主 / 备身份；非 hub、旧后端不下发、以及不关心这一段的构造方为空。 */
  hubMode?: HubMode | null;
  /** hub 侧 `last_seen_at`（毫秒）；hub 不可达时为 `null`。 */
  lastSeenAt: number | null;
  /** hub 侧 `nodes.status`；hub 不可达时为 `null`。 */
  status: string | null;
  certificate: string | null;
  certSig: string | null;
  /**
   * 入口记录的进行中长事务（远程卸载 / 主备切换）；`mergeNodes` 恒填，缺省为 `null`。
   * 声明成可选是为了不逼着每个手写 `NodeRow` 的测试夹具补这一项。
   */
  operation?: MeshNodeOperation | null;
  /** hub 侧的接纳状态；hub 不可达时为 `null`。 */
  admissionStatus?: HubAdmissionStatus | null;
  /** 待批准行：只存在于 hub 列表，还不是 mesh 成员，任何依赖证书的动作都不可用。 */
  pending?: boolean;
  /** 待批准行的 admit 材料；材料不全时为 `null`（此时只显示状态，批不了）。 */
  admitMaterial?: PendingAdmitMaterial | null;
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
  hubNodeId: string | null;
}

/**
 * 合并 mesh 列表与 hub 列表。mesh 列表是**已接纳成员**的权威集，hub 只补充心跳与状态；
 * hub 不可达时全部补充字段为 `null`，UI 据此禁用管理动作。
 *
 * 除此之外还补上一类 mesh 里没有的行：hub 说 `admission_status === 'pending'` 的节点。
 * 它们已经拿到证书却还没被本地密钥日志 `admit-node` 接纳（密码加入 passkey 账号的常态），
 * 不列出来用户就完全看不到「有一台机器在等批准」。
 */
export function mergeNodes(
  meshNodes: MeshNode[],
  hubNodes: HubNodeRow[] | null,
  context: MergeContext
): NodeRow[] {
  const hubById = new Map((hubNodes ?? []).map((row) => [row.id, row]));
  const admitted = sortNodes(meshNodes, context.entryNodeId).map((node) =>
    toAdmittedRow(node, hubById.get(node.id) ?? null, context)
  );
  return [...admitted, ...pendingRows(hubNodes, new Set(meshNodes.map((node) => node.id)))];
}

function toAdmittedRow(node: MeshNode, hub: HubNodeRow | null, context: MergeContext): NodeRow {
  return {
    id: node.id,
    runtimeNodeId: toRuntimeNodeId(node.id, context.entryNodeId),
    name: hub?.name ?? node.name,
    publicKey: node.publicKey,
    fingerprint: publicKeyFingerprint(node.publicKey),
    online: node.online,
    reach: reachOf(node.reach),
    transport: transportOf(node.transport),
    rttMs: rttOf(node.rttMs),
    version: node.version ?? hub?.version ?? null,
    directCapable: node.direct_capable || (hub?.direct_capable ?? false),
    loggedIn: node.loggedIn,
    inventory: node.inventory ?? null,
    isSelf: isEntryNode(node.id, context),
    isHub: isHubNode(node, context),
    hubMode: node.hubMode ?? null,
    operation: node.operation ?? null,
    ...hubColumns(hub),
    pending: false,
    admitMaterial: null,
  };
}

function isEntryNode(nodeId: string, context: MergeContext): boolean {
  return context.entryNodeId != null && nodeId === context.entryNodeId;
}

function isHubNode(node: MeshNode, context: MergeContext): boolean {
  return node.isHub === true || (context.hubNodeId != null && node.id === context.hubNodeId);
}

/** hub 列表补充的那几列；hub 不可达（`null`）时全部为 `null`，UI 据此禁用管理动作。 */
function hubColumns(
  hub: HubNodeRow | null
): Pick<NodeRow, 'lastSeenAt' | 'status' | 'certificate' | 'certSig' | 'admissionStatus'> {
  return {
    lastSeenAt: hub?.last_seen_at ?? null,
    status: hub?.status ?? null,
    certificate: hub?.certificate ?? null,
    certSig: hub?.cert_sig ?? null,
    admissionStatus: hub ? hubAdmissionStatus(hub) : null,
  };
}

/**
 * 只有 hub 列表里才有的待批准行；mesh 里已经有的同一台绝不重复列出。
 * 同 ID 只保留第一条：异常 / 过渡期的 hub 响应里出现两条同 ID pending 时，
 * 渲染出重复 React key 会让 busy 状态串行复用，还会给出两个可点的批准按钮。
 */
function pendingRows(hubNodes: HubNodeRow[] | null, meshIds: ReadonlySet<string>): NodeRow[] {
  const seen = new Set<string>();
  const rows: NodeRow[] = [];
  for (const row of hubNodes ?? []) {
    if (hubAdmissionStatus(row) !== 'pending' || meshIds.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(toPendingRow(row));
  }
  return rows.sort((a, b) => compareNames(a.name, b.name));
}

function toPendingRow(row: HubNodeRow): NodeRow {
  return {
    id: row.id,
    // 还没接纳的节点不可路由：运行时 id 只能是它自己，绝不会退化成 `self`。
    runtimeNodeId: row.id,
    name: row.name?.trim() || row.id.slice(0, 8),
    publicKey: '',
    fingerprint: '',
    online: false,
    reach: null,
    transport: null,
    rttMs: null,
    version: null,
    directCapable: false,
    loggedIn: false,
    inventory: null,
    isSelf: false,
    isHub: false,
    hubMode: null,
    lastSeenAt: row.last_seen_at ?? null,
    status: row.status ?? null,
    certificate: row.certificate ?? null,
    certSig: row.cert_sig ?? null,
    operation: null,
    admissionStatus: 'pending',
    pending: true,
    admitMaterial: admitMaterialOf(row),
  };
}

function admitMaterialOf(row: HubNodeRow): PendingAdmitMaterial | null {
  if (!row.enrollment_id || !row.authorization || !row.authorization_sig) return null;
  if (!row.certificate || !row.cert_sig) return null;
  return {
    enrollmentId: row.enrollment_id,
    authorization: row.authorization,
    authorizationSig: row.authorization_sig,
    certificate: row.certificate,
    certSig: row.cert_sig,
  };
}
