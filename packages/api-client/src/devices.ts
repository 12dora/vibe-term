// 设备管理 REST 端点

import type {
  CreateDeviceRequest,
  Device,
  TestConnectionResult,
  UpdateDeviceRequest,
} from '@vibeterm/shared';
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

export interface DeviceQueryOutcome<TData> {
  data: TData | undefined;
  isSuccess: boolean;
  isPlaceholderData: boolean;
}

/**
 * 「这一份 `['devices']` 查询结果算不算数」。
 *
 * 冷启动首帧的占位数据（宿主的本地设备快照）挂在每个 node 的 QueryClient 缺省上，同一个 key
 * 的每个观察者——设备管理面板、侧边栏设备树、控制台、宿主的 GlobalDeviceProvider——都会先
 * 拿到它。占位数据**只能用来渲染**：它可能已经过期，拿去驱动连接 / 订阅会连一台早就删掉的
 * 设备；拿去做乐观重排会用过期顺序覆盖服务端，且缓存里没有可回滚的基线；回写本地快照更是把
 * 自己抄一遍。所以每一条写路径与副作用都要先过这里。
 *
 * 判据放在这里（而不是各包各写一遍）：`apps/fe` 与 `packages/panels` 用的是同一条规则，
 * 各写一份迟早会漏掉某个观察者。真成功且非占位才算数——成功返回的空列表是事实，算数；
 * 失败态的空数组不是。
 */
export function isAuthoritativeDeviceQuery(
  query: Pick<DeviceQueryOutcome<unknown>, 'isSuccess' | 'isPlaceholderData'>
): boolean {
  return query.isSuccess && !query.isPlaceholderData;
}

/** 权威列表；占位 / 加载中 / 失败一律为 undefined。 */
export function authoritativeDeviceList<TData>(
  query: DeviceQueryOutcome<TData>
): TData | undefined {
  return isAuthoritativeDeviceQuery(query) ? query.data : undefined;
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
