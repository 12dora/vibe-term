// 多节点通知（汇聚声明）的 REST 客户端。契约在 `@tmex/shared`（contracts/mesh-notifications）。
//
// 端点缺席（老节点、或对端网关还没带这一族路由）一律折成 `supported: false`：卡片整块不渲染，
// standalone 与旧版本节点上看不出任何变化。

import { type ApiClient, parseApiError } from '@tmex/api-client';
import { requestJson } from '@tmex/api-client/json-mutation';
import {
  MESH_NOTIFICATION_ROUTE,
  type MeshNotificationState,
  type UpdateMeshNotificationRequest,
} from '@tmex/shared';

export const meshNotificationQueryKey = ['notifications-mesh'] as const;

const UNSUPPORTED: MeshNotificationState = { supported: false, selfEnabled: false, sinks: [] };

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

/** 端点缺席（404 / 501）视为「本机不支持」，不算错误。 */
function isAbsent(status: number): boolean {
  return status === 404 || status === 501;
}

export async function fetchMeshNotificationState(
  client: ApiClient,
  signal?: AbortSignal
): Promise<MeshNotificationState> {
  const res = await client.fetch(MESH_NOTIFICATION_ROUTE, signal ? { signal } : undefined);
  if (isAbsent(res.status)) return UNSUPPORTED;
  if (!res.ok) throw new Error(await parseApiError(res, `HTTP ${res.status}`));
  return toState(await res.json());
}

export async function updateMeshNotificationState(
  client: ApiClient,
  enabled: boolean
): Promise<MeshNotificationState> {
  const body: UpdateMeshNotificationRequest = { enabled };
  const wire = await requestJson<unknown>(client, MESH_NOTIFICATION_ROUTE, {
    method: 'PUT',
    body,
  });
  return toState(wire);
}
