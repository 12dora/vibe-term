// 多节点通知汇聚开关 REST 端点。
//
// 端点缺席（老节点、或对端网关还没带这一族路由）一律折成 `supported: false`：
// 调用方据此隐藏卡片，404 / 501 不抛错。

import {
  MESH_NOTIFICATION_ROUTE,
  type MeshNotificationState,
  type UpdateMeshNotificationRequest,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export const meshNotificationQueryKey = ['notifications-mesh'] as const;

const UNSUPPORTED: MeshNotificationState = { supported: false, selfEnabled: false, sinks: [] };

function isAbsent(status: number): boolean {
  return status === 404 || status === 501;
}

function toState(wire: unknown): MeshNotificationState {
  const state = wire as Partial<MeshNotificationState> | null;
  return {
    supported: state?.supported !== false,
    // 本机节点编号：签 `notification-sink` 记录要按它写 payload，老网关不下发时留空。
    ...(typeof state?.selfNodeId === 'string' && state.selfNodeId
      ? { selfNodeId: state.selfNodeId }
      : {}),
    selfEnabled: state?.selfEnabled === true,
    sinks: Array.isArray(state?.sinks) ? state.sinks : [],
    ...(state?.forwardQueue ? { forwardQueue: state.forwardQueue } : {}),
  };
}

export async function fetchMeshNotificationState(
  client: ApiClient = defaultApiClient,
  signal?: AbortSignal
): Promise<MeshNotificationState> {
  const res = await requestOk(client, MESH_NOTIFICATION_ROUTE, {
    signal,
    allowStatus: [404, 501],
  });
  if (isAbsent(res.status)) return UNSUPPORTED;
  return toState(await res.json());
}

export async function updateMeshNotificationState(
  enabled: boolean,
  client: ApiClient = defaultApiClient
): Promise<MeshNotificationState> {
  const body: UpdateMeshNotificationRequest = { enabled };
  return toState(
    await requestJson<unknown>(client, MESH_NOTIFICATION_ROUTE, {
      method: 'PUT',
      body,
    })
  );
}
