// 本机「接收其它节点的通知」开关：落 gateway_kv，进程内缓存一份。
// statusProvider 每次心跳都要读它做 jsonStable 比对，不能每次都打库。

import { getGatewayKv, setGatewayKv } from '../db/kv';

export const MESH_NOTIFY_SINK_KV_KEY = 'mesh.notification.sink.enabled';

let cached: boolean | null = null;

/** 本机是否为汇聚机。读不到库（迁移前/测试裸库）一律按关闭处理。 */
export function isMeshNotificationSinkEnabled(): boolean {
  if (cached !== null) return cached;
  try {
    cached = getGatewayKv(MESH_NOTIFY_SINK_KV_KEY) === '1';
  } catch {
    cached = false;
  }
  return cached;
}

export function setMeshNotificationSinkEnabled(enabled: boolean): void {
  setGatewayKv(MESH_NOTIFY_SINK_KV_KEY, enabled ? '1' : '0');
  cached = enabled;
}

/** 测试用：丢掉进程内缓存。 */
export function resetMeshNotificationSinkCache(): void {
  cached = null;
}
