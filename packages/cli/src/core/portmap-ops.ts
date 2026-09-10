// 端口映射：先在 B 建放行，再拿 mapId 去 A 建监听；第二步失败则撤掉第一步。

import type { CliContext } from './context';
import { CliError, NotFoundError } from './errors';
import { filesJson, resolveMeshId } from './files-api';
import { loginRequiredError } from './http';

export interface PortMapDto {
  id: string;
  name: string;
  listenHost: string;
  listenPort: number;
  targetNodeId: string;
  targetHost: string;
  targetPort: number;
  paused: boolean;
  state: string;
  error?: string;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
  createdAt: number;
  updatedAt: number;
}

export interface PortMapExportDto {
  mapId: string;
  fromNodeId: string;
  host: string;
  port: number;
  enabled: boolean;
  createdAt: number;
}

export interface PortProbeDto {
  host: string;
  port: number;
  free: boolean;
  reserved: boolean;
  usedByMapId: string | null;
}

export interface TargetProbeDto {
  host: string;
  port: number;
  listening: boolean;
}

export interface CreatePortMapInput {
  listenNodeId: string;
  targetNodeId: string;
  listenPort: number;
  listenHost: string;
  targetHost: string;
  targetPort: number;
  name?: string;
}

export async function listPortMaps(ctx: CliContext, nodeId: string): Promise<PortMapDto[]> {
  const payload = await filesJson<{ maps?: PortMapDto[] }>(ctx.http, nodeId, 'GET', '/api/portmap');
  return payload.maps ?? [];
}

export async function createPortMapping(
  ctx: CliContext,
  input: CreatePortMapInput
): Promise<PortMapDto> {
  const listenMesh = await resolveMeshId(ctx, input.listenNodeId);
  const targetMesh = await resolveMeshId(ctx, input.targetNodeId);
  const exported = await filesJson<{ export: PortMapExportDto }>(
    ctx.http,
    input.targetNodeId,
    'POST',
    '/api/portmap/exports',
    { fromNodeId: listenMesh, host: input.targetHost, port: input.targetPort }
  );
  const mapId = exported.export.mapId;
  try {
    const created = await filesJson<{ map: PortMapDto }>(
      ctx.http,
      input.listenNodeId,
      'POST',
      '/api/portmap',
      {
        name: input.name,
        listenHost: input.listenHost,
        listenPort: input.listenPort,
        targetNodeId: targetMesh,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        mapId,
      }
    );
    return created.map;
  } catch (error) {
    const existing = await findPortMap(ctx, input.listenNodeId, mapId);
    if (existing) return existing;
    const removed = await deleteExport(ctx, input.targetNodeId, mapId);
    if (!removed) {
      throw new CliError(
        `created export ${mapId} on ${input.targetNodeId} but the listen map failed; export was not removed`,
        1,
        `run: vibeterm port rm ${mapId} --on ${input.targetNodeId}`
      );
    }
    throw error;
  }
}

export async function deletePortMapping(
  ctx: CliContext,
  listenNodeId: string,
  mapId: string
): Promise<{ exportRemoved: boolean }> {
  const maps = await listPortMaps(ctx, listenNodeId);
  const map = maps.find((row) => row.id === mapId);
  if (!map) throw new NotFoundError(`port map ${mapId} not found on node ${listenNodeId}`);
  let exportRemoved = false;
  try {
    const payload = await filesJson<{ exportRemoved?: boolean }>(
      ctx.http,
      listenNodeId,
      'DELETE',
      `/api/portmap/${encodeURIComponent(mapId)}`
    );
    exportRemoved = payload?.exportRemoved === true;
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  if (exportRemoved) return { exportRemoved: true };
  const targetNodeId = runtimeNodeId(listenNodeId, map.targetNodeId);
  const removed = await deleteExport(ctx, targetNodeId, mapId);
  return { exportRemoved: removed };
}

export async function patchPortMap(
  ctx: CliContext,
  nodeId: string,
  mapId: string,
  body: { paused?: boolean; name?: string }
): Promise<PortMapDto> {
  const payload = await filesJson<{ map: PortMapDto }>(
    ctx.http,
    nodeId,
    'PATCH',
    `/api/portmap/${encodeURIComponent(mapId)}`,
    body
  );
  return payload.map;
}

export async function probeListen(
  ctx: CliContext,
  nodeId: string,
  host: string,
  port: number
): Promise<PortProbeDto> {
  const params = new URLSearchParams({ host, port: String(port) });
  return filesJson<PortProbeDto>(
    ctx.http,
    nodeId,
    'GET',
    `/api/portmap/probe?${params.toString()}`
  );
}

export async function probeTarget(
  ctx: CliContext,
  nodeId: string,
  host: string,
  port: number
): Promise<TargetProbeDto> {
  const params = new URLSearchParams({ host, port: String(port) });
  return filesJson<TargetProbeDto>(
    ctx.http,
    nodeId,
    'GET',
    `/api/portmap/target-probe?${params.toString()}`
  );
}

async function findPortMap(
  ctx: CliContext,
  nodeId: string,
  mapId: string
): Promise<PortMapDto | null> {
  try {
    const maps = await listPortMaps(ctx, nodeId);
    return maps.find((row) => row.id === mapId) ?? null;
  } catch {
    return null;
  }
}

async function deleteExport(ctx: CliContext, nodeId: string, mapId: string): Promise<boolean> {
  try {
    await filesJson(
      ctx.http,
      nodeId,
      'DELETE',
      `/api/portmap/exports/${encodeURIComponent(mapId)}`
    );
    return true;
  } catch (error) {
    if (error instanceof NotFoundError) return true;
    if (error instanceof CliError && error.exitCode === 3) {
      throw loginRequiredError(nodeId, error.message);
    }
    return false;
  }
}

function runtimeNodeId(listenNodeId: string, targetMeshId: string): string {
  return targetMeshId || listenNodeId;
}
