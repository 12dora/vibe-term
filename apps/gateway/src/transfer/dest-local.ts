// 本机目标的逐段下探。授权目录先 realpath 定死，之后每一段都 lstat：
// 遇到符号链接直接拒绝，不存在才建目录，建完再核对真实路径没有跑出授权目录。
// 只做词法校验是不够的——`inbox/link -> /root/private` 这种存量链接会把字节写到授权范围外。

import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import type { FileErrorCode } from '@vibeterm/shared';
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

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function mkdirFailCode(err: unknown): FileErrorCode {
  return errnoCode(err) === 'ENAMETOOLONG' ? 'invalid' : 'permission_denied';
}

/** 缺失则创建 0755 目录（chmod 绕开 umask）。并发创建不算失败。 */
function createAuthorizedDir(path: string): { error: FileErrorCode } | { created: boolean } {
  try {
    mkdirSync(path, { mode: 0o755 });
  } catch (err) {
    return lstatOrNull(path) === null ? { error: mkdirFailCode(err) } : { created: false };
  }
  try {
    chmodSync(path, 0o755);
  } catch {
    // chmod 失败仍由后续 lstat 复核
  }
  return { created: true };
}

function removeCreatedDirs(created: readonly string[]): void {
  for (let i = created.length - 1; i >= 0; i--) {
    const path = created[i];
    if (!path) continue;
    try {
      rmdirSync(path);
    } catch {
      // 越界后尽力收回刚建的目录
    }
  }
}

function inspectCreated(path: string): DestResult<void> {
  const st = lstatOrNull(path);
  if (st === null) return destFail('permission_denied');
  if (st.isSymbolicLink()) return destFail('outside_roots');
  if (!st.isDirectory()) return destFail('not_a_directory');
  return { ok: true, data: undefined };
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
  const created: string[] = [];
  for (const seg of dirs) {
    const next = joinPosix(cur, seg);
    const st = lstatOrNull(next);
    if (st === null) {
      if (!create) return destFail('not_found');
      const made = createAuthorizedDir(next);
      if ('error' in made) return destFail(made.error);
      if (made.created) created.push(next);
      const inspected = inspectCreated(next);
      if (!inspected.ok) {
        removeCreatedDirs(created);
        return inspected;
      }
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
    removeCreatedDirs(created);
    return destFail('not_found');
  }
  if (!withinBase(base, real)) {
    removeCreatedDirs(created);
    return destFail('outside_roots');
  }
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
