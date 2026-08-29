// 设备分组 REST 端点

import type {
  CreateDeviceFolderRequest,
  DeviceFolder,
  DeviceFolderLayout,
  UpdateDeviceFolderLayoutRequest,
  UpdateDeviceFolderRequest,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient, parseApiError } from './client';

export const deviceFoldersQueryKey = ['device-folders'] as const;

export async function fetchDeviceFolderLayout(
  client: ApiClient = defaultApiClient
): Promise<DeviceFolderLayout> {
  const res = await client.fetch('/api/device-folders');
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load device groups'));
  }
  return (await res.json()) as DeviceFolderLayout;
}

export async function createDeviceFolder(
  body: CreateDeviceFolderRequest,
  errorFallback = 'Failed to create group',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolder> {
  const res = await client.fetch('/api/device-folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  const payload = (await res.json()) as { folder: DeviceFolder };
  return payload.folder;
}

export async function updateDeviceFolder(
  id: string,
  body: UpdateDeviceFolderRequest,
  errorFallback = 'Failed to update group',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolder> {
  const res = await client.fetch(`/api/device-folders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  const payload = (await res.json()) as { folder: DeviceFolder };
  return payload.folder;
}

export async function deleteDeviceFolder(
  id: string,
  errorFallback = 'Failed to delete group',
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/device-folders/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
}

export async function replaceDeviceFolderLayout(
  body: UpdateDeviceFolderLayoutRequest,
  errorFallback = 'Failed to update group layout',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolderLayout> {
  const res = await client.fetch('/api/device-folders/layout', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as DeviceFolderLayout;
}

/** 恢复默认布局：删除全部分组，节点回到根层默认顺序。服务端一个事务完成。 */
export async function resetDeviceFolderLayout(
  errorFallback = 'Failed to reset group layout',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolderLayout> {
  const res = await client.fetch('/api/device-folders/reset', { method: 'POST' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as DeviceFolderLayout;
}
