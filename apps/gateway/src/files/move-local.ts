// 本机设备的移动 / 重命名：全程 node:fs，源的最后一段用 lstat 寻址、永不跟随符号链接。

import { type Stats, cpSync, lstatSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { mapFsError } from './local-fs';
import {
  type MoveBatch,
  type MoveItem,
  type MoveOutcome,
  isInsidePath,
  posixJoin,
} from './move-types';
import { enqueueDeviceJob } from './queue';
import { type FileOpResult, fail, ok } from './rsync-operation';

/** 暴露给测试替换（例如让 rename 抛 EXDEV 以覆盖跨文件系统回退）。 */
export const fileMoveIo = {
  rename: renameSync,
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

function copyThenRemove(src: string, dest: string, destExisted: boolean): MoveOutcome {
  try {
    fileMoveIo.cp(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
  } catch (err) {
    if (!destExisted) removeQuiet(dest);
    return moveError(err);
  }
  try {
    fileMoveIo.rm(src, { recursive: true, force: true });
    return ok(undefined);
  } catch (err) {
    return moveError(err);
  }
}

function performMove(src: string, dest: string, destExisted: boolean): MoveOutcome {
  try {
    fileMoveIo.rename(src, dest);
    return ok(undefined);
  } catch (err) {
    if (errnoOf(err) !== 'EXDEV') return moveError(err);
  }
  return copyThenRemove(src, dest, destExisted);
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
  return performMove(srcReal, destPath, conflict.data);
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
