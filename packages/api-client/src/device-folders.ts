// 设备分组 REST 端点

import type {
  CreateDeviceFolderRequest,
  DeviceFolder,
  DeviceFolderLayout,
  UpdateDeviceFolderLayoutRequest,
  UpdateDeviceFolderRequest,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export const deviceFoldersQueryKey = ['device-folders'] as const;

export async function fetchDeviceFolderLayout(
  client: ApiClient = defaultApiClient
): Promise<DeviceFolderLayout> {
  return requestJson<DeviceFolderLayout>(client, '/api/device-folders', {
    errorFallback: 'Failed to load device groups',
  });
}

export async function createDeviceFolder(
  body: CreateDeviceFolderRequest,
  errorFallback = 'Failed to create group',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolder> {
  return requestJson<{ folder: DeviceFolder }, DeviceFolder>(client, '/api/device-folders', {
    method: 'POST',
    body,
    errorFallback,
    pick: (payload) => payload.folder,
  });
}

export async function updateDeviceFolder(
  id: string,
  body: UpdateDeviceFolderRequest,
  errorFallback = 'Failed to update group',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolder> {
  return requestJson<{ folder: DeviceFolder }, DeviceFolder>(client, `/api/device-folders/${id}`, {
    method: 'PATCH',
    body,
    errorFallback,
    pick: (payload) => payload.folder,
  });
}

export async function deleteDeviceFolder(
  id: string,
  errorFallback = 'Failed to delete group',
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/device-folders/${id}`, { method: 'DELETE', errorFallback });
}

export async function replaceDeviceFolderLayout(
  body: UpdateDeviceFolderLayoutRequest,
  errorFallback = 'Failed to update group layout',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolderLayout> {
  return requestJson<DeviceFolderLayout>(client, '/api/device-folders/layout', {
    method: 'PUT',
    body,
    errorFallback,
  });
}

/** 恢复默认布局：删除全部分组，节点回到根层默认顺序。服务端一个事务完成。 */
export async function resetDeviceFolderLayout(
  errorFallback = 'Failed to reset group layout',
  client: ApiClient = defaultApiClient
): Promise<DeviceFolderLayout> {
  return requestJson<DeviceFolderLayout>(client, '/api/device-folders/reset', {
    method: 'POST',
    errorFallback,
  });
}
