// 多节点互联出站代理：`GET/PUT /api/settings/mesh-proxy`。
// 鉴权与 `/api/settings/site` 一致。落库后广播 SETTINGS_UPDATE，新拨号立即改策略。

import { type MeshProxyMode, isMeshProxyMode } from '@vibeterm/shared/net';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { getMeshProxyStore } from '../mesh/mesh-proxy-store';
import { broadcastSettingsUpdate } from './broadcaster';

export const INVALID_MESH_PROXY_MODE = 'INVALID_MESH_PROXY_MODE';
export const MESH_PROXY_SETTINGS_PATH = '/api/settings/mesh-proxy';

export type MeshProxyModeResponse = { meshProxy: MeshProxyMode };

function payload(): MeshProxyModeResponse {
  return { meshProxy: getMeshProxyStore().get() };
}

function handleGet(): Response {
  return json(payload());
}

async function handlePut(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || !isMeshProxyMode(body.meshProxy)) {
    return json(
      {
        code: INVALID_MESH_PROXY_MODE,
        error: {
          code: INVALID_MESH_PROXY_MODE,
          message: 'meshProxy must be direct or system',
        },
      },
      400
    );
  }
  getMeshProxyStore().set(body.meshProxy);
  broadcastSettingsUpdate('mesh-proxy');
  return json(payload());
}

export const meshProxySettingsRoutes: ApiRoute[] = [
  route({ method: 'GET', path: MESH_PROXY_SETTINGS_PATH, handler: () => handleGet() }),
  route({ method: 'PUT', path: MESH_PROXY_SETTINGS_PATH, handler: (req) => handlePut(req) }),
];
