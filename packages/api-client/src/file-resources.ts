// 文件根与目录/文件元信息的 REST 端点。

import type {
  BrowseDirectoryResponse,
  CreateFileRootRequest,
  FileContentResponse,
  FileRootResponse,
  FileStatResponse,
  ListFileRootsResponse,
  ListFilesResponse,
  UpdateFileRootRequest,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { parseError } from './file-errors';
import { filesApiUrl } from './file-urls';
import { type JsonRequestOptions, requestJson, requestOk } from './json-mutation';

/** 文件族一律抛 `FileApiError`（带 code），与两段式传输共用同一套解析。 */
function fileJson<T>(
  client: ApiClient,
  path: string,
  options: JsonRequestOptions = {}
): Promise<T> {
  return requestJson<T>(client, path, { ...options, toError: parseError });
}

export async function fetchFileRoots(
  client: ApiClient = defaultApiClient
): Promise<ListFileRootsResponse> {
  return fileJson<ListFileRootsResponse>(client, '/api/files/roots');
}

export async function createFileRoot(
  body: CreateFileRootRequest,
  client: ApiClient = defaultApiClient
): Promise<FileRootResponse> {
  return fileJson<FileRootResponse>(client, '/api/files/roots', { method: 'POST', body });
}

export async function updateFileRoot(
  id: string,
  body: UpdateFileRootRequest,
  client: ApiClient = defaultApiClient
): Promise<FileRootResponse> {
  return fileJson<FileRootResponse>(client, `/api/files/roots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

/** 侧栏拖拽排序：整份顺序一次提交，未列出的目录项保持相对顺序排在后面。 */
export async function reorderFileRoots(
  rootIds: string[],
  client: ApiClient = defaultApiClient
): Promise<ListFileRootsResponse> {
  return fileJson<ListFileRootsResponse>(client, '/api/files/roots/order', {
    method: 'PUT',
    body: { rootIds },
  });
}

export async function deleteFileRoot(
  id: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/files/roots/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    toError: parseError,
  });
}

export async function fetchFileList(
  rootId: string,
  path?: string,
  client: ApiClient = defaultApiClient
): Promise<ListFilesResponse> {
  return fileJson<ListFilesResponse>(client, filesApiUrl('list', rootId, path));
}

export async function fetchFileStat(
  rootId: string,
  path: string,
  client: ApiClient = defaultApiClient
): Promise<FileStatResponse> {
  return fileJson<FileStatResponse>(client, filesApiUrl('stat', rootId, path));
}

export async function fetchFileContent(
  rootId: string,
  path: string,
  client: ApiClient = defaultApiClient
): Promise<FileContentResponse> {
  return fileJson<FileContentResponse>(client, filesApiUrl('content', rootId, path));
}

/** 图形化路径选择器：列出设备上任意目录的子目录（不受 roots 白名单约束）。 */
export async function browseDirectory(
  params: { deviceId: string; path?: string; hidden?: boolean },
  client: ApiClient = defaultApiClient
): Promise<BrowseDirectoryResponse> {
  const search = new URLSearchParams({ deviceId: params.deviceId });
  if (params.path) search.set('path', params.path);
  if (params.hidden) search.set('hidden', '1');
  return fileJson<BrowseDirectoryResponse>(client, `/api/files/browse?${search.toString()}`);
}
