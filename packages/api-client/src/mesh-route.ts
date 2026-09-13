// 多节点互联「延迟优化」选路模式：`GET/PUT /api/settings/mesh-route`。

import type { MeshRouteMode } from '@vibeterm/shared/net';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson } from './json-mutation';

export const MESH_ROUTE_SETTINGS_PATH = '/api/settings/mesh-route';

export type MeshRouteModeResponse = { mode: MeshRouteMode };

export async function getMeshRouteMode(
  client: ApiClient = defaultApiClient
): Promise<MeshRouteModeResponse> {
  return requestJson<MeshRouteModeResponse>(client, MESH_ROUTE_SETTINGS_PATH, {
    errorFallback: 'mesh_route_mode_load_failed',
  });
}

export async function setMeshRouteMode(
  mode: MeshRouteMode,
  client: ApiClient = defaultApiClient
): Promise<MeshRouteModeResponse> {
  return requestJson<MeshRouteModeResponse>(client, MESH_ROUTE_SETTINGS_PATH, {
    method: 'PUT',
    body: { mode },
    errorFallback: 'mesh_route_mode_update_failed',
  });
}
