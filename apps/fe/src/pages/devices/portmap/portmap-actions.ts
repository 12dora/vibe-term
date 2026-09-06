// 映射的建立与删除。两条记录分别落在两个节点上：A 持有监听（映射），B 持有放行记录。
//
// 顺序固定：建立 = 先 B 放行、后 A 监听；删除 = 先 A、后 B。两步之间失败的补偿有两条硬规则：
//  1. 只有「A 明确拒绝」或「查到 A 上确实没有这条映射」才允许撤掉 B 的放行——响应丢了但 A 其实
//     建成了的话，撤放行会把一条活着的映射打成不可用，而端口还占着；
//  2. B 的放行删不掉不能当成功咽下去，否则 B 上留着一条对 A 的长期放行。删不掉就登记待清理。

import {
  ApiError,
  createNodeApiClient,
  createPortMap,
  createPortMapExport,
  deletePortMap,
  deletePortMapExport,
  listPortMaps,
} from '@vibeterm/api-client';
import type { ApiClient } from '@vibeterm/api-client';
import type { PortMapDto, PortMapErrorCode } from '@vibeterm/shared';

import {
  type PendingExportCleanup,
  recordPendingExportCleanup,
  resolvePendingExportCleanup,
} from './pending-cleanup';

export interface PortMapEndpoint {
  /** 运行时 node id（`self` 或 32 位 hex）。 */
  nodeId: string;
  /** 对端认得的真实 mesh node id。 */
  meshId: string;
  host: string;
  port: number;
}

/** 放行记录没能删掉时的登记口；缺省落到持久化的待清理清单。 */
export type PendingCleanupSink = (record: PendingExportCleanup) => void;

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'not_found');
}

/** 4xx 是对端明确拒绝（含转发层的登录 / 参数错误）：请求没有落库。5xx 与网络错误都算不确定。 */
function isDefiniteRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** 尽力删掉 B 的放行记录；已经不存在也算删掉了。 */
async function removeExport(client: ApiClient, mapId: string): Promise<boolean> {
  try {
    await deletePortMapExport(client, mapId);
    return true;
  } catch (error) {
    return isNotFound(error);
  }
}

async function findPortMap(client: ApiClient, mapId: string): Promise<PortMapDto | undefined> {
  const maps = await listPortMaps(client);
  return maps.find((map) => map.id === mapId);
}

export interface CreatePortMappingParams {
  listen: PortMapEndpoint;
  target: PortMapEndpoint;
  name: string;
}

type CreateOutcome =
  | { kind: 'created'; map: PortMapDto }
  | { kind: 'absent' }
  | { kind: 'unknown' };

/** 建映射的响应没拿到时，回头问 A：这条映射到底建没建成。 */
async function inspectCreate(
  client: ApiClient,
  mapId: string,
  error: unknown
): Promise<CreateOutcome> {
  if (isDefiniteRejection(error)) return { kind: 'absent' };
  try {
    const map = await findPortMap(client, mapId);
    return map ? { kind: 'created', map } : { kind: 'absent' };
  } catch {
    return { kind: 'unknown' };
  }
}

function cleanupRecord(
  params: CreatePortMappingParams | DeletePortMappingParams,
  mapId: string,
  confirmed: boolean
): PendingExportCleanup {
  return {
    mapId,
    listenMeshId: params.listen.meshId,
    targetMeshId: params.target.meshId,
    label: params.name || String(params.listen.port),
    confirmed,
    createdAt: Date.now(),
  };
}

export async function createPortMapping(
  params: CreatePortMappingParams,
  sink: PendingCleanupSink = recordPendingExportCleanup
): Promise<PortMapDto> {
  const { listen, target } = params;
  const targetClient = createNodeApiClient(target.nodeId);
  const listenClient = createNodeApiClient(listen.nodeId);

  const exported = await createPortMapExport(targetClient, {
    fromNodeId: listen.meshId,
    host: target.host,
    port: target.port,
  });

  try {
    return await createPortMap(listenClient, {
      name: params.name || undefined,
      listenHost: listen.host,
      listenPort: listen.port,
      targetNodeId: target.meshId,
      targetHost: target.host,
      targetPort: target.port,
      mapId: exported.mapId,
    });
  } catch (error) {
    const outcome = await inspectCreate(listenClient, exported.mapId, error);
    // A 其实建成了（只是响应没回来）：放行记录必须留着，这条映射是活的
    if (outcome.kind === 'created') return outcome.map;
    if (outcome.kind === 'unknown') {
      sink(cleanupRecord(params, exported.mapId, false));
    } else if (!(await removeExport(targetClient, exported.mapId))) {
      sink(cleanupRecord(params, exported.mapId, true));
    }
    throw error;
  }
}

export interface DeletePortMappingParams {
  listen: PortMapEndpoint;
  /** 目标节点；运行时 id 解析不到（节点已离开 mesh）时为 null，放行记录留待清理。 */
  target: Omit<PortMapEndpoint, 'nodeId'> & { nodeId: string | null };
  mapId: string;
  /** 待清理清单里的展示名。 */
  name: string;
}

/** 删 A 的映射；A 说「不存在」等同于已删。返回值告知 A 是否已顺带清掉 B 的放行记录。 */
async function deleteListenerMap(nodeId: string, mapId: string): Promise<boolean> {
  try {
    const result = await deletePortMap(createNodeApiClient(nodeId), mapId);
    return result.exportRemoved;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function deletePortMapping(
  params: DeletePortMappingParams,
  sink: PendingCleanupSink = recordPendingExportCleanup
): Promise<void> {
  if (await deleteListenerMap(params.listen.nodeId, params.mapId)) {
    resolvePendingExportCleanup(params.mapId);
    return;
  }
  const targetNodeId = params.target.nodeId;
  if (targetNodeId && (await removeExport(createNodeApiClient(targetNodeId), params.mapId))) {
    resolvePendingExportCleanup(params.mapId);
    return;
  }
  sink(cleanupRecord(params, params.mapId, true));
}

export type CleanupOutcome = 'removed' | 'live' | 'pending';

export interface RetryCleanupParams {
  record: PendingExportCleanup;
  /** 监听方 A 的运行时 id；解析不到时无法复核，未确认的记录只能继续挂着。 */
  listenNodeId: string | null;
  /** 目标方 B 的运行时 id；解析不到时无法清理。 */
  targetNodeId: string | null;
}

/** 复核 A：映射还在就说明这条记录本就不该清理。 */
async function confirmAbsent(
  record: PendingExportCleanup,
  listenNodeId: string | null
): Promise<CleanupOutcome | null> {
  if (record.confirmed) return null;
  if (!listenNodeId) return 'pending';
  try {
    const map = await findPortMap(createNodeApiClient(listenNodeId), record.mapId);
    return map ? 'live' : null;
  } catch {
    return 'pending';
  }
}

/**
 * 重试一条待清理：先（按需）复核 A 上确实没有这条映射，再删 B 的放行记录。
 * `removed` / `live` 都表示这条记录可以摘掉，`pending` 表示还得留着。
 */
export async function retryExportCleanup(params: RetryCleanupParams): Promise<CleanupOutcome> {
  const settled = await confirmAbsent(params.record, params.listenNodeId);
  if (settled) {
    if (settled === 'live') resolvePendingExportCleanup(params.record.mapId);
    return settled;
  }
  if (!params.targetNodeId) return 'pending';
  if (!(await removeExport(createNodeApiClient(params.targetNodeId), params.record.mapId))) {
    return 'pending';
  }
  resolvePendingExportCleanup(params.record.mapId);
  return 'removed';
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<PortMapErrorCode>([
  'invalid_request',
  'port_in_use',
  'port_reserved',
  'bind_failed',
  'not_found',
  'target_unreachable',
  'export_missing',
  'limit_reached',
]);

export function portMapErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? (error.code ?? error.error) : null;
  return code && KNOWN_ERROR_CODES.has(code)
    ? `devices.portmap.errors.${code}`
    : 'devices.portmap.errors.unknown';
}
