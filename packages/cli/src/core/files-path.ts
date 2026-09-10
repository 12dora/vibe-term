// 远程路径文法：`[<node>:]<rootId>:<relpath>` 或 `[<node>:]<rootName>/<relpath>`。
// 本地路径：以 `/` `./` `../` `~` 开头，或 Windows 盘符。cp 把其余一律当远程。

import { UsageError } from './errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_ID_RE = /^[0-9a-f]{32}$/;
const NODE_ALIASES = new Set(['self', 'local', 'entry', '.']);

export const VIRTUAL_FS_ROOT_ID = 'fs-root';

export interface RemoteFileRef {
  /** 未写为 null，由 `--node` 或 entry 自身补上。 */
  node: string | null;
  /** root id 或展示名。 */
  root: string;
  /** 相对 root 的路径；冒号形式可带前导 `/` 表示绝对路径。 */
  relpath: string;
}

export function isLocalPath(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;
  if (raw === '.' || raw === '..') return true;
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('~')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  return raw.startsWith('file:');
}

export function parseRemoteFileRef(input: string): RemoteFileRef {
  const raw = input.trim();
  if (!raw) throw new UsageError('path is empty');
  if (isLocalPath(raw)) {
    throw new UsageError(`expected a remote path [<node>:]<root>/<path>, got "${input}"`);
  }
  const { node, rest } = splitNodePrefix(raw);
  if (!rest) throw new UsageError(`missing root in path: ${input}`);
  const { root, relpath } = splitRootAndRel(rest);
  if (!root) throw new UsageError(`missing root in path: ${input}`);
  return { node, root, relpath };
}

function splitNodePrefix(input: string): { node: string | null; rest: string } {
  const colon = input.indexOf(':');
  if (colon <= 0) return { node: null, rest: input };
  const left = input.slice(0, colon);
  const right = input.slice(colon + 1);
  if (left.length === 1 && /[A-Za-z]/.test(left)) return { node: null, rest: input };
  if (isRootToken(left)) return { node: null, rest: input };
  if (isNodeToken(left) || right.includes(':') || right.includes('/') || right.length > 0) {
    return { node: left, rest: right };
  }
  return { node: null, rest: input };
}

function isRootToken(value: string): boolean {
  return UUID_RE.test(value) || value === VIRTUAL_FS_ROOT_ID;
}

function isNodeToken(value: string): boolean {
  return NODE_ID_RE.test(value) || NODE_ALIASES.has(value.toLowerCase());
}

function splitRootAndRel(rest: string): { root: string; relpath: string } {
  const colon = rest.indexOf(':');
  if (colon > 0 && isRootToken(rest.slice(0, colon))) {
    return { root: rest.slice(0, colon), relpath: rest.slice(colon + 1) };
  }
  const slash = rest.indexOf('/');
  if (slash < 0) return { root: rest, relpath: '' };
  return { root: rest.slice(0, slash), relpath: rest.slice(slash + 1) };
}

/** API 要绝对路径：相对段拼到 root.path 后面；已是 `/` 开头的原样用。 */
export function joinRootPath(rootPath: string, relpath: string): string {
  const rel = relpath.replace(/\/+$/, '');
  if (!rel || rel === '.') return rootPath;
  if (rel.startsWith('/')) return rel;
  const base = rootPath === '/' ? '' : rootPath.replace(/\/+$/, '');
  return `${base}/${rel}`;
}

export function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return '/';
  const index = trimmed.lastIndexOf('/');
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '') || '/';
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return '/';
  return trimmed.slice(0, index);
}

export function posixJoin(base: string, child: string): string {
  if (!child) return base;
  if (child.startsWith('/')) return child;
  const prefix = base === '/' ? '' : base.replace(/\/+$/, '');
  return `${prefix}/${child.replace(/^\/+/, '')}`;
}
