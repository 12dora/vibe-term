// 本机设备的移动 / 重命名：全程 node:fs，源的最后一段用 lstat 寻址、永不跟随符号链接。

import { randomBytes } from 'node:crypto';
import {
  type Stats,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { mapFsError } from './local-fs';
import {
  type MoveBatch,
  type MoveItem,
  type MoveOutcome,
  isInsidePath,
  posixDirname,
  posixJoin,
} from './move-types';
import { enqueueDeviceJob } from './queue';
import { type FileOpResult, fail, ok } from './rsync-operation';

/** 暴露给测试替换（例如让 rename 抛 EXDEV 以覆盖跨文件系统回退）。 */
export const fileMoveIo = {
  rename: renameSync,
  link: linkSync,
  unlink: unlinkSync,
  mkdir: mkdirSync,
  rmdir: rmdirSync,
  cp: cpSync,
  rm: rmSync,
  lstat: lstatSync,
  stat: statSync,
  realpath: realpathSync,
};

interface LocalCtx {
  realRoot: string;
  realDestDir: string;
  overwrite: boolean;
}

function errnoOf(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return '';
}

function moveError(err: unknown): MoveOutcome {
  const code = errnoOf(err);
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return fail('already_exists');
  return mapFsError(err);
}

function resolveDestDir(realDestRoot: string, destDir: string): FileOpResult<string> {
  let real: string;
  try {
    real = fileMoveIo.realpath(destDir);
  } catch (err) {
    return mapFsError(err);
  }
  if (!isInsidePath(real, realDestRoot)) return fail('outside_roots');
  try {
    if (!fileMoveIo.stat(real).isDirectory()) return fail('not_a_directory');
  } catch (err) {
    return mapFsError(err);
  }
  return ok(real);
}

function resolveContext(batch: MoveBatch): FileOpResult<LocalCtx> {
  let realRoot: string;
  let realDestRoot: string;
  try {
    realRoot = fileMoveIo.realpath(batch.rootPath);
    realDestRoot = fileMoveIo.realpath(batch.destRootPath);
  } catch {
    return fail('root_not_found');
  }
  const dir = resolveDestDir(realDestRoot, batch.destDir);
  if (!dir.ok) return dir;
  return ok({ realRoot, realDestDir: dir.data, overwrite: batch.overwrite });
}

interface ResolvedSource {
  srcReal: string;
  realParent: string;
  st: Stats;
}

function resolveSource(ctx: LocalCtx, item: MoveItem): FileOpResult<ResolvedSource> {
  let realParent: string;
  try {
    realParent = fileMoveIo.realpath(item.parent);
  } catch (err) {
    return mapFsError(err);
  }
  if (!isInsidePath(realParent, ctx.realRoot)) return fail('outside_roots');
  const srcReal = posixJoin(realParent, item.name);
  try {
    return ok({ srcReal, realParent, st: fileMoveIo.lstat(srcReal) });
  } catch (err) {
    return mapFsError(err);
  }
}

/** 目标已存在：`overwrite` 且双方都不是目录（文件或符号链接）才允许替换。 */
function checkConflict(ctx: LocalCtx, srcSt: Stats, destPath: string): FileOpResult<boolean> {
  let destSt: Stats;
  try {
    destSt = fileMoveIo.lstat(destPath);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return ok(false);
    return mapFsError(err);
  }
  if (ctx.overwrite && !srcSt.isDirectory() && !destSt.isDirectory()) return ok(true);
  return fail('already_exists');
}

function removeQuiet(path: string): void {
  try {
    fileMoveIo.rm(path, { recursive: true, force: true });
  } catch {
    // 尽力清理
  }
}

function attempt(action: () => void): void {
  try {
    action();
  } catch {
    // 回滚只是尽力而为，不能盖掉原始错误
  }
}

/** 文件系统不支持硬链接（或被策略禁止）时 link 的失败码，此时退回 lstat 检查 + rename。 */
const LINK_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
]);

function existsNoFollow(path: string): boolean {
  try {
    fileMoveIo.lstat(path);
    return true;
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return false;
    throw err;
  }
}

/**
 * 普通文件：link 对已存在的目标原子地报 EEXIST；返回 false 表示需要退回通用路径。
 * link 成功后删源失败时不回滚：此刻 dest 可能已被别的进程换成它们的文件，撤销会误删别人的数据，
 * 所以保留 dest、把本项报为失败（数据同时存在于两处，绝不删除任何东西）。
 */
function linkCommit(src: string, dest: string): boolean {
  try {
    fileMoveIo.link(src, dest);
  } catch (err) {
    if (LINK_FALLBACK_CODES.has(errnoOf(err))) return false;
    throw err;
  }
  fileMoveIo.unlink(src);
  return true;
}

/** 目录：mkdir 原子占位，再用 rename 覆盖这个空目录；失败只 rmdir 自己建的空目录。 */
function dirCommit(src: string, dest: string): void {
  fileMoveIo.mkdir(dest);
  try {
    fileMoveIo.rename(src, dest);
  } catch (err) {
    attempt(() => fileMoveIo.rmdir(dest));
    throw err;
  }
}

/**
 * 符号链接、特殊文件以及不支持硬链接的文件系统：无法原子占位，只能在 rename 前再查一次，
 * 检查与 rename 之间仍有残余窗口（目标恰在此刻被建出来会被 rename 覆盖）。Node / Bun 没有暴露
 * `renameat2(RENAME_NOREPLACE)`，所以这个窗口无法在这里消除；它只对并发的外部写入者有意义，
 * 本进程内同一设备的操作已被设备队列串行化。
 */
function guardedRename(src: string, dest: string): void {
  if (existsNoFollow(dest)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
  fileMoveIo.rename(src, dest);
}

/** 同一文件系统内把 src 落到 dest；`destExisted` 时按允许覆盖的 rename 原子替换，否则绝不替换。 */
function commitTo(st: Stats, src: string, dest: string, destExisted: boolean): void {
  if (destExisted) {
    fileMoveIo.rename(src, dest);
    return;
  }
  if (st.isFile() && linkCommit(src, dest)) return;
  if (st.isDirectory()) {
    dirCommit(src, dest);
    return;
  }
  guardedRename(src, dest);
}

/**
 * 跨文件系统：先复制到目标目录内的唯一临时同级项，再按同文件系统规则提交，最后才删源。
 * 失败只清理自己的临时项；源删除失败时已提交的目标原样保留（不回滚用户数据）。
 */
function copyThenRemove(src: string, dest: string, st: Stats, destExisted: boolean): MoveOutcome {
  const tmp = posixJoin(posixDirname(dest), `.vtmv-${randomBytes(6).toString('hex')}`);
  try {
    fileMoveIo.cp(src, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    commitTo(st, tmp, dest, destExisted);
  } catch (err) {
    removeQuiet(tmp);
    return moveError(err);
  }
  try {
    fileMoveIo.rm(src, { recursive: true, force: true });
    return ok(undefined);
  } catch (err) {
    return moveError(err);
  }
}

function performMove(src: string, dest: string, st: Stats, destExisted: boolean): MoveOutcome {
  try {
    commitTo(st, src, dest, destExisted);
    return ok(undefined);
  } catch (err) {
    if (errnoOf(err) !== 'EXDEV') return moveError(err);
  }
  return copyThenRemove(src, dest, st, destExisted);
}

function moveOne(ctx: LocalCtx, item: MoveItem): MoveOutcome {
  const src = resolveSource(ctx, item);
  if (!src.ok) return src;
  const { srcReal, realParent, st } = src.data;
  if (realParent === ctx.realDestDir && item.name === item.destName) return ok(undefined);
  const destPath = posixJoin(ctx.realDestDir, item.destName);
  if (st.isDirectory() && isInsidePath(destPath, srcReal)) return fail('invalid');
  const conflict = checkConflict(ctx, st, destPath);
  if (!conflict.ok) return conflict;
  return performMove(srcReal, destPath, st, conflict.data);
}

/** 整批在同一个设备级队列任务内串行执行；单项失败不影响后续项。 */
export function moveLocal(
  deviceId: string,
  batch: MoveBatch
): Promise<FileOpResult<MoveOutcome[]>> {
  return enqueueDeviceJob<FileOpResult<MoveOutcome[]>>(deviceId, async () => {
    const ctx = resolveContext(batch);
    if (!ctx.ok) return ctx;
    return ok(batch.items.map((item) => moveOne(ctx.data, item)));
  });
}
