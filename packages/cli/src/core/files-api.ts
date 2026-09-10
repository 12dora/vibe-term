// 文件 REST：根列表、解析、list/stat/raw。403 的 outside_roots 不当成未登录。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { fetchAuthMode } from './auth';
import type { CliContext } from './context';
import { CliError, NotFoundError, UsageError } from './errors';
import { VIRTUAL_FS_ROOT_ID, joinRootPath } from './files-path';
import type { HttpClient } from './http';
import { loginRequiredError } from './http';

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
const DENIED_CODES = new Set(['outside_roots', 'root_disabled', 'permission_denied']);

export async function filesJson<T>(
  http: HttpClient,
  nodeId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await http.fetch(nodeId, path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.ok) return readOkBody<T>(response);
  throw translateFilesError(nodeId, path, response.status, (await response.text()).trim());
}

async function readOkBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function translateFilesError(nodeId: string, path: string, status: number, text: string): never {
  const code = errorCode(text);
  if (status === 401) throw loginRequiredError(nodeId, text);
  if (status === 403 && code && DENIED_CODES.has(code)) {
    throw new CliError(`${path} → ${code}${text ? `: ${text}` : ''}`.trim());
  }
  if (status === 404 || (code !== null && NOT_FOUND_CODES.has(code))) {
    throw new NotFoundError(`${path} → ${code ?? 'not found'}`);
  }
  if (status === 403) throw loginRequiredError(nodeId, text);
  throw new CliError(`${path} → HTTP ${status} ${text}`.trim());
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

/** entry 的真实 mesh id；standalone / 取不到时退回 runtime nodeId。 */
export async function resolveMeshId(ctx: CliContext, nodeId: string): Promise<string> {
  if (nodeId !== SELF_NODE_ID) return nodeId;
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  return mode?.nodeId && mode.nodeId !== SELF_NODE_ID ? mode.nodeId : nodeId;
}

export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}
