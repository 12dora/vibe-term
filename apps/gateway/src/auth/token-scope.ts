import type { AccessTokenScope } from '@vibeterm/shared';

const ALWAYS_ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/auth/mode' },
  { method: 'GET', path: '/api/devices' },
  { method: 'GET', path: '/api/mesh/nodes' },
];

const FILES_PREFIX = '/api/files/';
const FILE_ROOTS_PATH = '/api/files/roots';
const PORTMAP_PATH = '/api/portmap';

function isExecPath(method: string, path: string): boolean {
  if (method === 'POST') return path === '/api/exec';
  return method === 'GET' && path === '/api/exec/ws';
}

function isFilesPath(method: string, path: string): boolean {
  if (!path.startsWith(FILES_PREFIX)) return false;
  const rootsConfig = path === FILE_ROOTS_PATH || path.startsWith(`${FILE_ROOTS_PATH}/`);
  return !rootsConfig || method === 'GET';
}

function isForwardPath(path: string): boolean {
  return path === PORTMAP_PATH || path.startsWith(`${PORTMAP_PATH}/`);
}

/**
 * 令牌调用方的作用域表：基础只读面始终放行，其余按 scope 逐类放行，表外一律拒绝。
 * `/api/files/roots` 的写操作会改动文件浏览根，属于节点配置，令牌不得调用。
 */
export function tokenScopeAllows(
  method: string,
  path: string,
  scopes: readonly AccessTokenScope[]
): boolean {
  const verb = method.toUpperCase();
  if (ALWAYS_ALLOWED.some((row) => row.method === verb && row.path === path)) return true;
  if (scopes.includes('exec') && isExecPath(verb, path)) return true;
  if (scopes.includes('files') && isFilesPath(verb, path)) return true;
  return scopes.includes('forward') && isForwardPath(path);
}
