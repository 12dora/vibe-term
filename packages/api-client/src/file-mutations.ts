// 文件变更类 REST 端点：删除 / 移动 / 重命名 / 打包下载准备。

import type {
  DeleteFilesRequest,
  DeleteFilesResponse,
  MoveFilesRequest,
  MoveFilesResponse,
  PrepareArchiveRequest,
  PrepareArchiveResponse,
  RenameFileRequest,
  RenameFileResponse,
} from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from './client';
import { FileApiError, parseError } from './file-errors';
import { requestJson } from './json-mutation';

function postFileJson<T>(client: ApiClient, path: string, body: unknown): Promise<T> {
  return requestJson<T>(client, path, { method: 'POST', body, toError: parseError });
}

/** 批量删除；逐项结果在 `results`，单项失败不影响其余项。 */
export function deleteFiles(
  body: DeleteFilesRequest,
  client: ApiClient = defaultApiClient
): Promise<DeleteFilesResponse> {
  return postFileJson<DeleteFilesResponse>(client, '/api/files/delete', body);
}

/** 批量移动到 `destDir`；逐项结果在 `results`。 */
export function moveFiles(
  body: MoveFilesRequest,
  client: ApiClient = defaultApiClient
): Promise<MoveFilesResponse> {
  return postFileJson<MoveFilesResponse>(client, '/api/files/move', body);
}

/** 同目录重命名；目标已存在时抛 `already_exists`。 */
export function renameFile(
  body: RenameFileRequest,
  client: ApiClient = defaultApiClient
): Promise<RenameFileResponse> {
  return postFileJson<RenameFileResponse>(client, '/api/files/rename', body);
}

/** 创建一次性打包票据，随后用 `fileArchiveUrl` 直接下载。 */
export function prepareArchive(
  body: PrepareArchiveRequest,
  client: ApiClient = defaultApiClient
): Promise<PrepareArchiveResponse> {
  return postFileJson<PrepareArchiveResponse>(client, '/api/files/archive/prepare', body);
}

// 这些码是文件业务本身的 404；网关不认识路由时返回 `route_not_found`（旧节点可能无码）。
const BUSINESS_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  'not_found',
  'device_not_found',
  'root_not_found',
]);

/** 节点过旧、网关不认识该文件路由：404 且不是文件业务的 404 码。 */
export function isFileRouteUnsupported(error: unknown): boolean {
  if (!(error instanceof FileApiError) || error.status !== 404) return false;
  return error.code === undefined || !BUSINESS_NOT_FOUND_CODES.has(error.code);
}
