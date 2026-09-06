// 多节点通知汇聚开关 REST 端点

import {
  MESH_NOTIFICATION_ROUTE,
  type MeshNotificationState,
  type UpdateMeshNotificationRequest,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';

export async function fetchMeshNotificationState(
  client: ApiClient = defaultApiClient
): Promise<MeshNotificationState> {
  const res = await client.fetch(MESH_NOTIFICATION_ROUTE);
  if (!res.ok) {
    throw new Error('Failed to load mesh notification state');
  }
  return (await res.json()) as MeshNotificationState;
}

export async function updateMeshNotificationState(
  enabled: boolean,
  client: ApiClient = defaultApiClient
): Promise<MeshNotificationState> {
  const body: UpdateMeshNotificationRequest = { enabled };
  const res = await client.fetch(MESH_NOTIFICATION_ROUTE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('Failed to update mesh notification state');
  }
  return (await res.json()) as MeshNotificationState;
}
