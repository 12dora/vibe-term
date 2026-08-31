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

export async function fetchFileRoots(
  client: ApiClient = defaultApiClient
): Promise<ListFileRootsResponse> {
  const res = await client.fetch('/api/files/roots');
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ListFileRootsResponse;
}

export async function createFileRoot(
  body: CreateFileRootRequest,
  client: ApiClient = defaultApiClient
): Promise<FileRootResponse> {
  const res = await client.fetch('/api/files/roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileRootResponse;
}

export async function updateFileRoot(
  id: string,
  body: UpdateFileRootRequest,
  client: ApiClient = defaultApiClient
): Promise<FileRootResponse> {
  const res = await client.fetch(`/api/files/roots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileRootResponse;
}

/** 侧栏拖拽排序：整份顺序一次提交，未列出的目录项保持相对顺序排在后面。 */
export async function reorderFileRoots(
  rootIds: string[],
  client: ApiClient = defaultApiClient
): Promise<ListFileRootsResponse> {
  const res = await client.fetch('/api/files/roots/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootIds }),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ListFileRootsResponse;
}

export async function deleteFileRoot(
  id: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  const res = await client.fetch(`/api/files/roots/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await parseError(res);
}

export async function fetchFileList(
  rootId: string,
  path?: string,
  client: ApiClient = defaultApiClient
): Promise<ListFilesResponse> {
  const res = await client.fetch(filesApiUrl('list', rootId, path));
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as ListFilesResponse;
}

export async function fetchFileStat(
  rootId: string,
  path: string,
  client: ApiClient = defaultApiClient
): Promise<FileStatResponse> {
  const res = await client.fetch(filesApiUrl('stat', rootId, path));
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileStatResponse;
}

export async function fetchFileContent(
  rootId: string,
  path: string,
  client: ApiClient = defaultApiClient
): Promise<FileContentResponse> {
  const res = await client.fetch(filesApiUrl('content', rootId, path));
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as FileContentResponse;
}

/** 图形化路径选择器：列出设备上任意目录的子目录（不受 roots 白名单约束）。 */
export async function browseDirectory(
  params: { deviceId: string; path?: string; hidden?: boolean },
  client: ApiClient = defaultApiClient
): Promise<BrowseDirectoryResponse> {
  const search = new URLSearchParams({ deviceId: params.deviceId });
  if (params.path) search.set('path', params.path);
  if (params.hidden) search.set('hidden', '1');
  const res = await client.fetch(`/api/files/browse?${search.toString()}`);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BrowseDirectoryResponse;
}
