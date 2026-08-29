// 设备文件夹 REST 端点

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
    throw new Error(await parseApiError(res, 'Failed to load device folders'));
  }
  return (await res.json()) as DeviceFolderLayout;
}

export async function createDeviceFolder(
  body: CreateDeviceFolderRequest,
  errorFallback = 'Failed to create folder',
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
  errorFallback = 'Failed to update folder',
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
  errorFallback = 'Failed to delete folder',
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/device-folders/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
}

export async function replaceDeviceFolderLayout(
  body: UpdateDeviceFolderLayoutRequest,
  errorFallback = 'Failed to update folder layout',
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
