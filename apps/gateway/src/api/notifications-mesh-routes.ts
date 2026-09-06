// 多节点通知汇聚开关：`GET/PUT /api/notifications/mesh`。
// 鉴权与其它设置端点一致（由 `/api/` 总入口统一守卫）。

import {
  MESH_NOTIFICATION_ROUTE,
  MESH_NOTIFICATION_SETTINGS_NAMESPACE,
  type MeshNotificationState,
} from '@tmex/shared';
import { meshForwardChannel } from '../events/channels/mesh-forward';
import { getMeshNotificationBridge } from '../mesh/notification-mesh-bridge';
import {
  isMeshNotificationSinkEnabled,
  setMeshNotificationSinkEnabled,
} from '../mesh/notification-sink-state';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

export function readMeshNotificationState(): MeshNotificationState {
  const bridge = getMeshNotificationBridge();
  return {
    supported: bridge != null,
    selfEnabled: isMeshNotificationSinkEnabled(),
    sinks: bridge?.listSinks() ?? [],
    forwardQueue: meshForwardChannel.stats(),
  };
}

function handleGet(): Response {
  return json(readMeshNotificationState());
}

async function handlePut(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw || typeof raw.enabled !== 'boolean') {
    return json({ error: 'invalid_request' }, 400);
  }
  setMeshNotificationSinkEnabled(raw.enabled);
  getMeshNotificationBridge()?.advertise();
  broadcastSettingsUpdate(MESH_NOTIFICATION_SETTINGS_NAMESPACE);
  return json(readMeshNotificationState());
}

export const notificationsMeshRoutes: ApiRoute[] = [
  route({ method: 'GET', path: MESH_NOTIFICATION_ROUTE, handler: () => handleGet() }),
  route({ method: 'PUT', path: MESH_NOTIFICATION_ROUTE, handler: (req) => handlePut(req) }),
];
