// 文件根与目录/文件元信息的 REST 端点。

import type {
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
