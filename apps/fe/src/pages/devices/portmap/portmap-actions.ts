// 映射的建立与删除。两条记录分别落在两个节点上，顺序固定：
// 建立 = 先 B 放行、后 A 监听（A 失败就撤掉 B 的放行）；删除 = 先 A、后 B（B 失败只是留个孤儿记录）。

import {
  ApiError,
  createNodeApiClient,
  createPortMap,
  createPortMapExport,
  deletePortMap,
  deletePortMapExport,
} from '@tmex/api-client';
import type { PortMapDto, PortMapErrorCode } from '@tmex/shared';

export interface PortMapEndpoint {
  /** 运行时 node id（`self` 或 32 位 hex）。 */
  nodeId: string;
  /** 对端认得的真实 mesh node id。 */
  meshId: string;
  host: string;
  port: number;
}

export interface CreatePortMappingParams {
  listen: PortMapEndpoint;
  target: PortMapEndpoint;
  name: string;
}

export async function createPortMapping(params: CreatePortMappingParams): Promise<PortMapDto> {
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
    await deletePortMapExport(targetClient, exported.mapId).catch(() => undefined);
    throw error;
  }
}

export interface DeletePortMappingParams {
  listenNodeId: string;
  /** 目标节点的运行时 id；解析不到（节点已离开 mesh）时跳过放行记录的清理。 */
  targetNodeId: string | null;
  mapId: string;
}

export async function deletePortMapping(params: DeletePortMappingParams): Promise<void> {
  await deletePortMap(createNodeApiClient(params.listenNodeId), params.mapId);
  if (!params.targetNodeId) return;
  await deletePortMapExport(createNodeApiClient(params.targetNodeId), params.mapId).catch(
    () => undefined
  );
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
