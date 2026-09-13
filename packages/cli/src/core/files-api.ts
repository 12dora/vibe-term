// 文件 REST：根列表、解析、list/stat/raw。错误映射统一交给 `http.assertOk`
// （403 的 outside_roots 等业务码是权限错误，不当成未登录）。

import { ApiClient } from '@vibeterm/api-client/client';
import { FileApiError } from '@vibeterm/api-client/file-errors';
import {
  type MkdirPathRequest,
  type MkdirPathResponse,
  mkdirPath,
} from '@vibeterm/api-client/file-resources';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import type { BrowseDirectoryResponse } from '@vibeterm/shared';
import { fetchAuthMode } from './auth';
import type { CliContext } from './context';
import { CliError, NotFoundError, UsageError } from './errors';
import { VIRTUAL_FS_ROOT_ID, joinRootPath } from './files-path';
import type { HttpClient, RequestOptions } from './http';
import { httpStatusError } from './http';

export interface FileRootDto {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: string | null;
  path: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
}

export interface FileEntryDto {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  category: string;
  size: number | null;
  modifiedAt: string | null;
  isSymlink: boolean;
}

export interface FileStatDto {
  path: string;
  name: string;
  type: FileEntryDto['type'];
  category: string;
  size: number;
  modifiedAt: string | null;
  mime: string | null;
  isSymlink: boolean;
}

export interface FileListDto {
  path: string;
  entries: FileEntryDto[];
  truncated: boolean;
}

export function filesQuery(endpoint: string, rootId: string, path?: string): string {
  const params = new URLSearchParams({ rootId });
  if (path !== undefined && path !== '') params.set('path', path);
  return `/api/files/${endpoint}?${params.toString()}`;
}

function errorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    if (typeof parsed.code === 'string') return parsed.code;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON
  }
  return null;
}

const NOT_FOUND_CODES = new Set(['not_found', 'root_not_found', 'device_not_found']);
/** 网关全局 404 的稳定业务码（apps/gateway/src/api/index.ts）。 */
const ROUTE_NOT_FOUND_CODE = 'route_not_found';
/** 更旧的节点只回本地化文案；英文站点是 `Not found`，只保留这一层兜底。 */
const LEGACY_ROUTE_NOT_FOUND_TEXT = /^not\s?found$/i;

export async function filesJson<T>(
  http: HttpClient,
  nodeId: string,
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  const { headers: extraHeaders, ...rest } = options;
  const headers = new Headers(extraHeaders);
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await http.fetch(nodeId, path, {
    ...rest,
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await http.assertOk(nodeId, response, path);
  return readOkBody<T>(response);
}

async function readOkBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export class MkdirUnsupportedError extends CliError {
  constructor(nodeId: string) {
    super(
      `node ${nodeId} does not support POST /api/files/mkdir`,
      1,
      'upgrade the node, or copy files into an existing directory (cp -r needs mkdir)'
    );
    this.name = 'MkdirUnsupportedError';
  }
}

/**
 * 路由不存在（旧节点）与业务 `not_found`（父目录缺失）都是 404，靠 body 区分：
 * 优先认网关的稳定码 `route_not_found`，没有该字段时才回退英文文案 / 无码兜底。
 */
export function isMissingRoute(status: number, text: string): boolean {
  if (status !== 404) return false;
  const code = errorCode(text);
  if (code === ROUTE_NOT_FOUND_CODE) return true;
  if (code === null) return true;
  if (NOT_FOUND_CODES.has(code)) return false;
  return LEGACY_ROUTE_NOT_FOUND_TEXT.test(code);
}

/**
 * 把 CLI 的 `HttpClient` 包成 api-client 的 `ApiClient`：node 前缀、cookie 罐、Origin、
 * TLS、超时全留在 `HttpClient` 里，端点函数只负责 URL 与请求体。
 */
function nodeApiClient(
  http: HttpClient,
  nodeId: string,
  hooks: { signal?: AbortSignal; onErrorBody?: (text: string) => void } = {}
): ApiClient {
  return new ApiClient('', async (url, init) => {
    const { signal, ...rest } = init ?? {};
    const effective = signal ?? hooks.signal;
    const response = await http.fetch(nodeId, url, {
      ...rest,
      ...(effective ? { signal: effective } : {}),
    });
    if (!response.ok && hooks.onErrorBody) {
      hooks.onErrorBody((await response.clone().text()).trim());
    }
    return response;
  });
}

/** 复用 api-client 的 `mkdirPath`（URL / 请求体唯一来源），错误按 CLI 的退出码语义翻译。 */
export async function mkdirRemote(
  http: HttpClient,
  nodeId: string,
  body: MkdirPathRequest,
  signal?: AbortSignal
): Promise<MkdirPathResponse> {
  let errorBody = '';
  const client = nodeApiClient(http, nodeId, {
    signal,
    onErrorBody: (text) => {
      errorBody = text;
    },
  });
  try {
    return await mkdirPath(body, client);
  } catch (error) {
    if (!(error instanceof FileApiError)) throw error;
    if (isMissingRoute(error.status, errorBody)) throw new MkdirUnsupportedError(nodeId);
    throw httpStatusError(nodeId, '/api/files/mkdir', error.status, errorBody);
  }
}

export async function listFileRoots(http: HttpClient, nodeId: string): Promise<FileRootDto[]> {
  const payload = await filesJson<{ roots?: FileRootDto[] }>(
    http,
    nodeId,
    'GET',
    '/api/files/roots'
  );
  return payload.roots ?? [];
}

export function resolveFileRoot(roots: readonly FileRootDto[], ref: string): FileRootDto {
  const raw = ref.trim();
  if (!raw) throw new UsageError('root is empty');
  if (raw === VIRTUAL_FS_ROOT_ID) {
    const enabled = roots.filter((root) => root.enabled);
    if (enabled.length === 0) {
      return {
        id: VIRTUAL_FS_ROOT_ID,
        deviceId: '',
        deviceName: null,
        deviceType: 'local',
        path: '/',
        name: '/',
        enabled: true,
        sortOrder: 0,
      };
    }
    throw new UsageError(
      'virtual root fs-root is only valid when the node has no enabled file roots',
      'use a root id or name from `vibeterm files roots`'
    );
  }
  const byId = roots.find((root) => root.id === raw);
  if (byId) return byId;
  const exact = roots.filter((root) => root.name === raw);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new UsageError(
      `root name "${raw}" is ambiguous: ${exact.map((root) => root.id).join(', ')}`,
      'use the root id'
    );
  }
  const insensitive = roots.filter((root) => root.name.toLowerCase() === raw.toLowerCase());
  if (insensitive.length === 1) return insensitive[0];
  throw new NotFoundError(`unknown file root: ${raw}`, 'run: vibeterm files roots');
}

export async function resolveRemotePath(
  ctx: CliContext,
  spec: { node: string | null; root: string; relpath: string }
): Promise<{ nodeId: string; root: FileRootDto; absPath: string }> {
  const nodeId = spec.node
    ? (await ctx.resolver.resolveNode(spec.node)).id
    : await ctx.targetNodeId();
  const roots = await listFileRoots(ctx.http, nodeId);
  const root = resolveFileRoot(roots, spec.root);
  return { nodeId, root, absPath: joinRootPath(root.path, spec.relpath) };
}

export async function listDirectory(
  http: HttpClient,
  nodeId: string,
  rootId: string,
  absPath: string
): Promise<FileListDto> {
  return filesJson<FileListDto>(http, nodeId, 'GET', filesQuery('list', rootId, absPath));
}

export async function statRemote(
  http: HttpClient,
  nodeId: string,
  rootId: string,
  absPath: string
): Promise<FileStatDto> {
  return filesJson<FileStatDto>(http, nodeId, 'GET', filesQuery('stat', rootId, absPath));
}

export async function createFileRoot(
  http: HttpClient,
  nodeId: string,
  body: { deviceId: string; path: string; enabled?: boolean }
): Promise<FileRootDto> {
  const payload = await filesJson<{ root: FileRootDto }>(
    http,
    nodeId,
    'POST',
    '/api/files/roots',
    body
  );
  return payload.root;
}

export async function deleteFileRoot(http: HttpClient, nodeId: string, id: string): Promise<void> {
  await filesJson(http, nodeId, 'DELETE', `/api/files/roots/${encodeURIComponent(id)}`);
}

export async function reorderFileRoots(
  http: HttpClient,
  nodeId: string,
  rootIds: string[]
): Promise<FileRootDto[]> {
  const payload = await filesJson<{ roots?: FileRootDto[] }>(
    http,
    nodeId,
    'PUT',
    '/api/files/roots/order',
    { rootIds }
  );
  return payload.roots ?? [];
}

export async function patchFileRoot(
  http: HttpClient,
  nodeId: string,
  id: string,
  body: { enabled?: boolean; path?: string; sortOrder?: number }
): Promise<FileRootDto> {
  const payload = await filesJson<{ root: FileRootDto }>(
    http,
    nodeId,
    'PATCH',
    `/api/files/roots/${encodeURIComponent(id)}`,
    body
  );
  return payload.root;
}

/** `GET /api/files/browse`：query 与 api-client `browseDirectory` 一致。 */
export async function browseDirectoryOnNode(
  http: HttpClient,
  nodeId: string,
  params: { deviceId: string; path?: string; hidden?: boolean }
): Promise<BrowseDirectoryResponse> {
  const search = new URLSearchParams({ deviceId: params.deviceId });
  if (params.path) search.set('path', params.path);
  if (params.hidden) search.set('hidden', '1');
  return filesJson<BrowseDirectoryResponse>(
    http,
    nodeId,
    'GET',
    `/api/files/browse?${search.toString()}`
  );
}

/** entry 的真实 mesh id；standalone / 取不到时退回 runtime nodeId。 */
export async function resolveMeshId(ctx: CliContext, nodeId: string): Promise<string> {
  if (nodeId !== SELF_NODE_ID) return nodeId;
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  return mode?.nodeId && mode.nodeId !== SELF_NODE_ID ? mode.nodeId : nodeId;
}

export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}
