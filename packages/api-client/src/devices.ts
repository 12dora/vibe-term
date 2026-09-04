// 设备管理 REST 端点

import type {
  CreateDeviceRequest,
  Device,
  TestConnectionResult,
  UpdateDeviceRequest,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient, toApiError } from './client';
import { requestJson, requestOk } from './json-mutation';

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

// 多个包共享 ['devices'] 查询缓存且约定形态为 { devices }，故列表端点保留信封返回；
// 该端点还需透传调用方的 RequestInit（如 signal），不走 requestJson
export async function fetchDevices(
  client: ApiClient = defaultApiClient,
  init?: RequestInit
): Promise<DevicesResponse> {
  const res = await client.fetch('/api/devices', init);
  if (!res.ok) {
    // 类型化错误：面板要按 `NODE_LOGIN_REQUIRED` / `NODE_UNREACHABLE` 分别提示，
    // 宿主还要据此补一次该 node 的静默重登（见 apps/fe 的 node-session-recovery）。
    throw await toApiError(res, 'Failed to load devices');
  }
  return (await res.json()) as DevicesResponse;
}

export async function createDevice(
  body: CreateDeviceRequest,
  errorFallback = 'Failed to create device',
  client: ApiClient = defaultApiClient
): Promise<Device> {
  return requestJson<{ device: Device }, Device>(client, '/api/devices', {
    method: 'POST',
    body,
    errorFallback,
    pick: (payload) => payload.device,
  });
}

export async function updateDevice(
  deviceId: string,
  body: UpdateDeviceRequest,
  errorFallback = 'Failed to update device',
  client: ApiClient = defaultApiClient
): Promise<Device> {
  return requestJson<{ device: Device }, Device>(client, `/api/devices/${deviceId}`, {
    method: 'PATCH',
    body,
    errorFallback,
    pick: (payload) => payload.device,
  });
}

// 既有调用方对删除失败一律展示固定文案，故不解析响应体中的 error 字段
export async function deleteDevice(
  deviceId: string,
  errorMessage = 'Failed to delete device',
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/devices/${deviceId}`, {
    method: 'DELETE',
    toError: () => new Error(errorMessage),
  });
}

export async function reorderDevices(
  deviceIds: string[],
  client: ApiClient = defaultApiClient
): Promise<DevicesResponse> {
  return requestJson<DevicesResponse>(client, '/api/devices/order', {
    method: 'PUT',
    body: { deviceIds },
    errorFallback: 'Failed to reorder devices',
  });
}

// 连接失败（success: false）同样是 200 载荷，由调用方按 TestConnectionResult 呈现；
// 仅设备不存在等错误走非 2xx 抛错分支
export async function testDeviceConnection(
  deviceId: string,
  errorFallback = 'Connection test failed',
  client: ApiClient = defaultApiClient
): Promise<TestConnectionResult> {
  return requestJson<TestConnectionResult>(client, `/api/devices/${deviceId}/test-connection`, {
    method: 'POST',
    errorFallback,
  });
}
