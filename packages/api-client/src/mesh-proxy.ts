// 多节点互联「节点连接代理」：`GET/PUT /api/settings/mesh-proxy`。

import type { MeshProxyMode } from '@vibeterm/shared/net';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson } from './json-mutation';

export const MESH_PROXY_SETTINGS_PATH = '/api/settings/mesh-proxy';

export type MeshProxyResponse = { meshProxy: MeshProxyMode };

export async function getMeshProxy(
  client: ApiClient = defaultApiClient
): Promise<MeshProxyResponse> {
  return requestJson<MeshProxyResponse>(client, MESH_PROXY_SETTINGS_PATH, {
    errorFallback: 'mesh_proxy_load_failed',
  });
}

export async function setMeshProxy(
  meshProxy: MeshProxyMode,
  client: ApiClient = defaultApiClient
): Promise<MeshProxyResponse> {
  return requestJson<MeshProxyResponse>(client, MESH_PROXY_SETTINGS_PATH, {
    method: 'PUT',
    body: { meshProxy },
    errorFallback: 'mesh_proxy_update_failed',
  });
}
