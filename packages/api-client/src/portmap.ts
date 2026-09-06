// 端口映射的 REST 端点。监听方 A 持有 `port_maps`（列表 / 创建 / 暂停 / 删除 / 端口占用探测），
// 目标方 B 持有 `port_map_exports`（放行记录 / 目标端口探测）；两侧各用自己的节点客户端调用。

import type {
  CreatePortMapExportRequest,
  CreatePortMapRequest,
  ListPortMapExportsResponse,
  ListPortMapsResponse,
  PortMapDto,
  PortMapExportDto,
  PortMapExportResponse,
  PortMapResponse,
  PortProbeResponse,
  TargetPortProbeResponse,
  UpdatePortMapRequest,
} from '@vibeterm/shared';
import { type ApiClient, toApiError } from './client';
import { requestJson, requestOk } from './json-mutation';

export const PORTMAP_PATH = '/api/portmap';
export const PORTMAP_EXPORTS_PATH = '/api/portmap/exports';

export function portMapPath(id: string): string {
  return `${PORTMAP_PATH}/${encodeURIComponent(id)}`;
}

export function portMapExportPath(mapId: string): string {
  return `${PORTMAP_EXPORTS_PATH}/${encodeURIComponent(mapId)}`;
}

function probeQuery(base: string, host: string, port: number): string {
  const params = new URLSearchParams({ host, port: String(port) });
  return `${base}?${params.toString()}`;
}

export function portProbePath(host: string, port: number): string {
  return probeQuery(`${PORTMAP_PATH}/probe`, host, port);
}

export function targetProbePath(host: string, port: number): string {
  return probeQuery(`${PORTMAP_PATH}/target-probe`, host, port);
}

function portmapError(fallback: string) {
  return (res: Response) => toApiError(res, fallback);
}

export function listPortMaps(client: ApiClient, signal?: AbortSignal): Promise<PortMapDto[]> {
  return requestJson<ListPortMapsResponse, PortMapDto[]>(client, PORTMAP_PATH, {
    signal,
    toError: portmapError('Failed to load port maps'),
    pick: (wire) => wire.maps,
  });
}

export function createPortMap(
  client: ApiClient,
  body: CreatePortMapRequest,
  signal?: AbortSignal
): Promise<PortMapDto> {
  return requestJson<PortMapResponse, PortMapDto>(client, PORTMAP_PATH, {
    method: 'POST',
    body,
    signal,
    toError: portmapError('Failed to create port map'),
    pick: (wire) => wire.map,
  });
}

export function updatePortMap(
  client: ApiClient,
  id: string,
  body: UpdatePortMapRequest,
  signal?: AbortSignal
): Promise<PortMapDto> {
  return requestJson<PortMapResponse, PortMapDto>(client, portMapPath(id), {
    method: 'PATCH',
    body,
    signal,
    toError: portmapError('Failed to update port map'),
    pick: (wire) => wire.map,
  });
}

export interface DeletePortMapResult {
  /** A 侧是否已顺带删掉 B 上的放行记录；响应里没有该字段（老节点 / 空响应体）按 false 处理。 */
  exportRemoved: boolean;
}

export async function deletePortMap(client: ApiClient, id: string): Promise<DeletePortMapResult> {
  const res = await requestOk(client, portMapPath(id), {
    method: 'DELETE',
    toError: portmapError('Failed to delete port map'),
  });
  const body = await res.json().catch(() => null);
  const removed =
    typeof body === 'object' && body !== null
      ? (body as { exportRemoved?: unknown }).exportRemoved === true
      : false;
  return { exportRemoved: removed };
}

/** A 侧：监听端口是否可绑定。 */
export function probeListenPort(
  client: ApiClient,
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<PortProbeResponse> {
  return requestJson<PortProbeResponse>(client, portProbePath(host, port), {
    signal,
    toError: portmapError('Failed to probe port'),
  });
}

export function listPortMapExports(
  client: ApiClient,
  signal?: AbortSignal
): Promise<PortMapExportDto[]> {
  return requestJson<ListPortMapExportsResponse, PortMapExportDto[]>(client, PORTMAP_EXPORTS_PATH, {
    signal,
    toError: portmapError('Failed to load port map exports'),
    pick: (wire) => wire.exports,
  });
}

/** B 侧：先建放行记录拿到 mapId，再拿它去 A 建映射。 */
export function createPortMapExport(
  client: ApiClient,
  body: CreatePortMapExportRequest,
  signal?: AbortSignal
): Promise<PortMapExportDto> {
  return requestJson<PortMapExportResponse, PortMapExportDto>(client, PORTMAP_EXPORTS_PATH, {
    method: 'POST',
    body,
    signal,
    toError: portmapError('Failed to create port map export'),
    pick: (wire) => wire.export,
  });
}

export async function deletePortMapExport(client: ApiClient, mapId: string): Promise<void> {
  await requestOk(client, portMapExportPath(mapId), {
    method: 'DELETE',
    toError: portmapError('Failed to delete port map export'),
  });
}

/** B 侧：目标端口当前是否有服务在监听（仅提示，不阻断创建）。 */
export function probeTargetPort(
  client: ApiClient,
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<TargetPortProbeResponse> {
  return requestJson<TargetPortProbeResponse>(client, targetProbePath(host, port), {
    signal,
    toError: portmapError('Failed to probe target port'),
  });
}
