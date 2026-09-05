// mesh 成员列表的首帧兜底缓存（localStorage）。
//
// PWA / 刷新后每次都是冷启动：`/api/auth/mode` → `/api/mesh/nodes` 两次串行往返落地之前
// 侧边栏一个节点头都没有，弱网下能空好几秒。这里把最近一次成功的列表落盘，模块加载时
// 同步读回去当第一帧，REST 回来再整份换掉（`stale` 标记表示当前渲染的是这份缓存）。
//
// 只落**渲染分节头需要的字段**：链路现场（reach / transport / rtt / 对端地址 / 建链时刻 /
// 直连失败）一律清空——它们描述的是上一次会话里那条链路，冷启动后必然过期，显示出来只会
// 是错的。鉴权相关的 `/api/auth/mode` 主体也不落盘，只留一个「上次是不是 mesh」的布尔值。

import type { MeshNode } from '@tmex/api-client/auth/index';

const CACHE_KEY = 'tmex:mesh-nodes';
const CACHE_VERSION = 1;

/** 超过这个年龄的缓存直接丢弃：成员集早就变了，拿它当第一帧只会显示一堆不存在的节点。 */
export const MESH_NODES_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 条数上限：localStorage 配额有限，异常大的列表一律不落盘。 */
export const MESH_NODES_CACHE_MAX_ROWS = 64;

export interface MeshNodesCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MeshNodesCache {
  /** 上次 `/api/auth/mode` 是不是 mesh。 */
  mesh: boolean;
  entryNodeId: string | null;
  nodes: MeshNode[];
  savedAt: number;
}

function defaultStorage(): MeshNodesCacheStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 落盘前把链路现场清掉，只留身份与在线态。 */
function toCachedNode(node: MeshNode): MeshNode {
  return {
    id: node.id,
    name: node.name,
    publicKey: node.publicKey,
    online: node.online,
    reach: null,
    version: node.version ?? null,
    direct_capable: node.direct_capable === true,
    inventory: node.inventory ?? null,
    loggedIn: node.loggedIn === true,
    isHub: node.isHub === true ? true : undefined,
  };
}

function isCachedNode(value: unknown): value is MeshNode {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.name === 'string' &&
    typeof row.publicKey === 'string' &&
    typeof row.online === 'boolean' &&
    typeof row.loggedIn === 'boolean'
  );
}

export function readMeshNodesCache(
  storage: MeshNodesCacheStorage | null = defaultStorage(),
  now = Date.now()
): MeshNodesCache | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== CACHE_VERSION) return null;
    const savedAt = typeof record.savedAt === 'number' ? record.savedAt : 0;
    // 未来时刻（改过系统时钟）同样按过期处理：它永远不会自己老掉。
    if (savedAt <= 0 || now - savedAt >= MESH_NODES_CACHE_MAX_AGE_MS || savedAt > now) return null;
    if (!Array.isArray(record.nodes)) return null;
    const nodes = record.nodes.filter(isCachedNode).map(toCachedNode);
    return {
      mesh: record.mesh === true,
      entryNodeId: typeof record.entryNodeId === 'string' ? record.entryNodeId : null,
      nodes,
      savedAt,
    };
  } catch {
    return null;
  }
}

export function writeMeshNodesCache(
  value: MeshNodesCache,
  storage: MeshNodesCacheStorage | null = defaultStorage()
): void {
  if (!storage) return;
  if (value.nodes.length > MESH_NODES_CACHE_MAX_ROWS) return;
  try {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        v: CACHE_VERSION,
        mesh: value.mesh,
        entryNodeId: value.entryNodeId,
        nodes: value.nodes.map(toCachedNode),
        savedAt: value.savedAt,
      })
    );
  } catch {
    // 配额满 / 隐私模式：缓存只是加速，写不进去不影响正确性
  }
}

/** 登出、退出 mesh、entry 换人时必须清掉：这份列表属于上一个身份。 */
export function clearMeshNodesCache(
  storage: MeshNodesCacheStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
