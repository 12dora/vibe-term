// 两套远程路径文法：
// - `files` 子命令（parseRemoteFileRef）：`[<node>:]<rootId>:<relpath>` 或 `[<node>:]<rootName>/<relpath>`。
//   根展示名为 `/` 时必须用 `<rootId>:` 形式，斜杠形式会和本地绝对路径撞车。
// - `cp`（isLocalPath / parseCpFileRef）：scp 语义，冒号前不含 `/` 才是远端 `<node>:<path>`，其余一律本地。

import { VIRTUAL_FS_ROOT_ID } from '@vibeterm/shared';
import { UsageError } from './errors';

export { VIRTUAL_FS_ROOT_ID };

/** 网关虚拟 home 根（`$HOME`）；与 `fs-root` 一样可走冒号形式。 */
export const VIRTUAL_HOME_ROOT_ID = 'home-root';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_ID_RE = /^[0-9a-f]{32}$/;
const NODE_ALIASES = new Set(['self', 'local', 'entry', '.']);

export interface RemoteFileRef {
  /** 未写为 null，由 `--node` 或 entry 自身补上。 */
  node: string | null;
  /** root id 或展示名。 */
  root: string;
  /** 相对 root 的路径；冒号形式可带前导 `/` 表示绝对路径。 */
  relpath: string;
}

/** `cp` 的远端引用：冒号形式的旧根写法，或 scp 风格的 `<node>:<path>`（path 为空 / 绝对 / 相对）。 */
export type CpFileRef =
  | { form: 'root'; node: string | null; root: string; relpath: string }
  | { form: 'path'; node: string | null; path: string };

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** 冒号前的主机段不含 `/`、不是盘符、不是 `file:`、不以 `~` 开头，才是 `<node>:<path>`。 */
export function isRemoteSpec(input: string): boolean {
  const raw = input.trim();
  if (!raw || raw.startsWith('~') || raw.startsWith('file:') || WINDOWS_DRIVE_RE.test(raw)) {
    return false;
  }
  const colon = raw.indexOf(':');
  if (colon <= 0) return false;
  const host = raw.slice(0, colon);
  return !host.includes('/') && !host.includes('\\');
}

export function isLocalPath(input: string): boolean {
  const raw = input.trim();
  return raw !== '' && !isRemoteSpec(raw);
}

function hasLegacyLocalPrefix(raw: string): boolean {
  if (raw === '.' || raw === '..') return true;
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('~')) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(raw)) return true;
  return raw.startsWith('file:');
}

export function parseCpFileRef(input: string): CpFileRef {
  const raw = input.trim();
  if (!raw) throw new UsageError('path is empty');
  if (!isRemoteSpec(raw)) {
    throw new UsageError(`expected a remote path <node>:<path>, got "${input}"`);
  }
  const colon = raw.indexOf(':');
  const host = raw.slice(0, colon);
  const tail = raw.slice(colon + 1);
  if (isRootToken(host)) return cpRootRef(null, host, tail);
  const inner = tail.indexOf(':');
  if (inner > 0 && isRootToken(tail.slice(0, inner))) {
    return cpRootRef(host, tail.slice(0, inner), tail.slice(inner + 1));
  }
  rejectDotDot(tail);
  return { form: 'path', node: host, path: tail };
}

function cpRootRef(node: string | null, root: string, relpath: string): CpFileRef {
  rejectDotDot(relpath);
  return { form: 'root', node, root, relpath };
}

/** 折叠 `//` 与 `.` 段、去掉尾部斜杠；含 `..` 直接拒绝。 */
export function normalizePosixPath(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new UsageError('path must not contain ".." segments');
  return `/${segments.join('/')}`;
}

/** `p` 是否落在 `root` 内（按路径段比较，`/data2` 不在 `/data` 内）；两者须已规范化。 */
export function isPathInside(root: string, p: string): boolean {
  if (root === '/') return true;
  return p === root || p.startsWith(`${root}/`);
}

export function parseRemoteFileRef(input: string): RemoteFileRef {
  const raw = input.trim();
  if (!raw) throw new UsageError('path is empty');
  if (hasLegacyLocalPrefix(raw)) {
    throw new UsageError(`expected a remote path [<node>:]<root>/<path>, got "${input}"`);
  }
  const { node, rest } = splitNodePrefix(raw);
  if (!rest) throw new UsageError(`missing root in path: ${input}`);
  const { root, relpath } = splitRootAndRel(rest);
  if (!root) throw new UsageError(`missing root in path: ${input}`);
  rejectDotDot(relpath);
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
  return UUID_RE.test(value) || value === VIRTUAL_FS_ROOT_ID || value === VIRTUAL_HOME_ROOT_ID;
}

function isNodeToken(value: string): boolean {
  return NODE_ID_RE.test(value) || NODE_ALIASES.has(value.toLowerCase());
}

function splitRootAndRel(rest: string): { root: string; relpath: string } {
  const colon = rest.indexOf(':');
  if (colon > 0) {
    const left = rest.slice(0, colon);
    const right = rest.slice(colon + 1);
    // UUID / fs-root 的冒号形式；末尾单独一个冒号表示「就是这个根」。
    if (isRootToken(left) || right === '') return { root: left, relpath: right };
  }
  const slash = rest.indexOf('/');
  if (slash < 0) return { root: rest, relpath: '' };
  return { root: rest.slice(0, slash), relpath: rest.slice(slash + 1) };
}

function rejectDotDot(relpath: string): void {
  if (relpath.split(/[/\\]/).some((segment) => segment === '..')) {
    throw new UsageError('path must not contain ".." segments');
  }
}

/** API 要绝对路径：相对段拼到 root.path 后面；已是 `/` 开头的原样用。 */
export function joinRootPath(rootPath: string, relpath: string): string {
  rejectDotDot(relpath);
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
