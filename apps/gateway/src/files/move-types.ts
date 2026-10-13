// 移动 / 重命名的共享类型与纯函数，local / remote 两条实现共用。

import type { FileErrorCode } from '@vibeterm/shared';
import type { FileOpResult } from './rsync-operation';

export interface MoveItem {
  /** 词法规范化后的源绝对路径（严格位于源 root 内） */
  path: string;
  /** 源所在目录（词法） */
  parent: string;
  /** 源 basename */
  name: string;
  /** 目标 basename：移动时等于 `name`，重命名时为新名字 */
  destName: string;
}

export interface MoveBatch {
  rootPath: string;
  destRootPath: string;
  /** 词法规范化后的目标目录 */
  destDir: string;
  overwrite: boolean;
  items: MoveItem[];
}

/** 与 `MoveBatch.items` 同序的逐项结果 */
export type MoveOutcome = FileOpResult<undefined>;

export function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

export function posixJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** `child` 等于 `base` 或位于其下（兼容 base 为 `/`）。 */
export function isInsidePath(child: string, base: string): boolean {
  if (child === base) return true;
  const prefix = base === '/' ? '/' : `${base}/`;
  return child.startsWith(prefix);
}

export function lexicalInside(
  rootPath: string,
  inputPath: string
): { ok: true; path: string } | { ok: false; code: FileErrorCode } {
  if (!inputPath || inputPath.includes('\0') || !inputPath.startsWith('/')) {
    return { ok: false, code: 'invalid' };
  }
  const normPath = posixNormalize(inputPath);
  if (!isInsidePath(normPath, posixNormalize(rootPath))) {
    return { ok: false, code: 'outside_roots' };
  }
  return { ok: true, path: normPath };
}

/** 重命名用的单段文件名：非空、非 `.`/`..`、无 `/` `\` NUL、UTF-8 ≤ 255 字节。 */
export function isValidSegmentName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return Buffer.byteLength(name, 'utf8') <= 255;
}
