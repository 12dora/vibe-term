// 设备管理 REST 端点

import type {
  CreateDeviceRequest,
  Device,
  TestConnectionResult,
  UpdateDeviceRequest,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient, parseApiError } from './client';

export const devicesQueryKey = ['devices'] as const;

// GET 列表/单个设备返回体在 Device 之上附带运行时状态字段（gateway enrichDeviceWithRuntime）
export type DeviceWithRuntime = Device & {
  lastSeenAt: string | null;
  lastError: string | null;
  lastErrorType: string | null;
  tmuxAvailable: boolean;
};

export interface DevicesResponse {
  devices: DeviceWithRuntime[];
}

// 多个包共享 ['devices'] 查询缓存且约定形态为 { devices }，故列表端点保留信封返回
export async function fetchDevices(client: ApiClient = defaultApiClient): Promise<DevicesResponse> {
  const res = await client.fetch('/api/devices');
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load devices'));
  }
  return (await res.json()) as DevicesResponse;
}

export async function createDevice(
  body: CreateDeviceRequest,
  errorFallback = 'Failed to create device',
  client: ApiClient = defaultApiClient
): Promise<Device> {
  const res = await client.fetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  const payload = (await res.json()) as { device: Device };
  return payload.device;
}

export async function updateDevice(
  deviceId: string,
  body: UpdateDeviceRequest,
  errorFallback = 'Failed to update device',
  client: ApiClient = defaultApiClient
): Promise<Device> {
  const res = await client.fetch(`/api/devices/${deviceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  const payload = (await res.json()) as { device: Device };
  return payload.device;
}

// 既有调用方对删除失败一律展示固定文案，故不解析响应体中的 error 字段
export async function deleteDevice(
  deviceId: string,
  errorMessage = 'Failed to delete device',
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(errorMessage);
  }
}

export async function reorderDevices(
  deviceIds: string[],
  client: ApiClient = defaultApiClient
): Promise<DevicesResponse> {
  const res = await client.fetch('/api/devices/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceIds }),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to reorder devices'));
  }
  return (await res.json()) as DevicesResponse;
}

// 连接失败（success: false）同样是 200 载荷，由调用方按 TestConnectionResult 呈现；
// 仅设备不存在等错误走非 2xx 抛错分支
export async function testDeviceConnection(
  deviceId: string,
  errorFallback = 'Connection test failed',
  client: ApiClient = defaultApiClient
): Promise<TestConnectionResult> {
  const res = await client.fetch(`/api/devices/${deviceId}/test-connection`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as TestConnectionResult;
}
