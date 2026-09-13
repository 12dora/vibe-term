// 多节点互联「延迟优化」选路模式：`GET/PUT /api/settings/mesh-route`。
// 鉴权与 `/api/settings/site` 一致（由 `/api/` 总入口统一守卫）。进程内热更新走 store 订阅，不广播 SETTINGS_EVENT。

import { type MeshRouteMode, isMeshRouteMode } from '@vibeterm/shared/net';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { getMeshRouteModeStore } from '../mesh/route-mode-store';

export const INVALID_MESH_ROUTE_MODE = 'INVALID_MESH_ROUTE_MODE';
export const MESH_ROUTE_SETTINGS_PATH = '/api/settings/mesh-route';

export type MeshRouteModeResponse = { mode: MeshRouteMode };

function payload(): MeshRouteModeResponse {
  return { mode: getMeshRouteModeStore().get() };
}

function handleGet(): Response {
  return json(payload());
}

async function handlePut(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || !isMeshRouteMode(body.mode)) {
    return json(
      {
        code: INVALID_MESH_ROUTE_MODE,
        error: { code: INVALID_MESH_ROUTE_MODE, message: 'mode must be auto, direct, or relay' },
      },
      400
    );
  }
  getMeshRouteModeStore().set(body.mode);
  return json(payload());
}

export const meshRouteSettingsRoutes: ApiRoute[] = [
  route({ method: 'GET', path: MESH_ROUTE_SETTINGS_PATH, handler: () => handleGet() }),
  route({ method: 'PUT', path: MESH_ROUTE_SETTINGS_PATH, handler: (req) => handlePut(req) }),
];
