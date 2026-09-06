// 本机目标的逐段下探。授权目录先 realpath 定死，之后每一段都 lstat：
// 遇到符号链接直接拒绝，不存在才建目录，建完再核对真实路径没有跑出授权目录。
// 只做词法校验是不够的——`inbox/link -> /root/private` 这种存量链接会把字节写到授权范围外。

import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import type { FileErrorCode } from '@tmex/shared';
import { type DestResult, destFail, joinPosix, splitRelPath } from './dest';

type LinkStat = { isSymbolicLink(): boolean; isDirectory(): boolean };

function lstatOrNull(path: string): LinkStat | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function withinBase(base: string, path: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * 从 `base`（已 realpath）逐段进入 `dirs`。`create` 为真时缺失的段就地创建；
 * 任一段是符号链接、或建出来的目录 realpath 跑出 `base`，一律判为越界。
 */
export function resolveAuthorizedDir(
  base: string,
  dirs: readonly string[],
  create: boolean
): DestResult<string> {
  let cur = base;
  for (const seg of dirs) {
    const next = joinPosix(cur, seg);
    const st = lstatOrNull(next);
    if (st === null) {
      if (!create) return destFail('not_found');
      try {
        mkdirSync(next, { mode: 0o755 });
      } catch {
        // 并发创建（另一条流刚建好）不算失败，下面统一复核
        if (lstatOrNull(next) === null) return destFail('permission_denied');
      }
      const created = lstatOrNull(next);
      if (created === null) return destFail('permission_denied');
      if (created.isSymbolicLink()) return destFail('outside_roots');
      if (!created.isDirectory()) return destFail('not_a_directory');
    } else if (st.isSymbolicLink()) {
      return destFail('outside_roots');
    } else if (!st.isDirectory()) {
      return destFail('not_a_directory');
    }
    cur = next;
  }
  let real: string;
  try {
    real = realpathSync(cur);
  } catch {
    return destFail('not_found');
  }
  if (!withinBase(base, real)) return destFail('outside_roots');
  return { ok: true, data: real };
}

export interface AuthorizedFile {
  /** 授权目录内的绝对路径 */
  absPath: string;
  /** 目标文件已存在（含指向别处的符号链接） */
  exists: boolean;
}

/**
 * 解析一个相对路径的最终落点。`partPath` 传入时一并核对半成品文件名没有被人换成符号链接
 * ——`.part-<hash>` 是本模块独占的命名空间，那里出现链接只可能是攻击。
 */
export function resolveAuthorizedFile(
  base: string,
  rel: string,
  opts: { create: boolean; partPathOf?: (abs: string) => string }
): DestResult<AuthorizedFile> {
  const { dirs, name } = splitRelPath(rel);
  if (!name) return destFail('invalid');
  const dir = resolveAuthorizedDir(base, dirs, opts.create);
  if (!dir.ok) return dir;
  const absPath = joinPosix(dir.data, name);
  const st = lstatOrNull(absPath);
  if (st?.isDirectory()) return destFail('is_directory');
  const partPath = opts.partPathOf?.(absPath);
  if (partPath) {
    const part = lstatOrNull(partPath);
    if (part?.isSymbolicLink()) return destFail('invalid');
  }
  return { ok: true, data: { absPath, exists: st !== null } };
}

export type { FileErrorCode };
