import { lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import type { FileErrorCode } from '@vibeterm/shared';
import { mapFsError } from './local-fs';
import { enqueueDeviceJob } from './queue';
import { type FileOpResult, fail, ok } from './rsync-operation';

export type DeleteStatus = 'ok' | FileErrorCode;

/** `index` 是该路径在请求 `paths` 中的下标，用于把执行结果对回原顺序。 */
export interface DeleteTarget {
  index: number;
  path: string;
}

export type DeleteOutcome = Map<number, DeleteStatus>;

export function posixNormalize(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined;
}

export function posixDirname(absPath: string): string {
  const i = absPath.lastIndexOf('/');
  return i <= 0 ? '/' : absPath.slice(0, i);
}

export function posixBasename(absPath: string): string {
  return absPath.slice(absPath.lastIndexOf('/') + 1);
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root === '/' ? '/' : `${root}/`);
}

function statusOfError(err: unknown): DeleteStatus {
  const mapped = mapFsError(err);
  return mapped.ok ? 'unknown' : mapped.code;
}

/**
 * 父目录必须 realpath 在 root 之内；末段只做 lstat，符号链接按链接本身 unlink，
 * 绝不跟随。实际删除用「真实父目录 + 末段名」，避免父目录路径在核对后被换成链接。
 */
export function deleteLocalOne(realRoot: string, target: string): DeleteStatus {
  let entry: string;
  try {
    const realParent = realpathSync(posixDirname(target));
    if (!isInside(realRoot, realParent)) return 'outside_roots';
    const prefix = realParent === '/' ? '' : realParent;
    entry = `${prefix}/${posixBasename(target)}`;
  } catch (err) {
    return statusOfError(err);
  }
  try {
    const st = lstatSync(entry);
    if (st.isDirectory()) rmSync(entry, { recursive: true, force: false });
    else unlinkSync(entry);
    return 'ok';
  } catch (err) {
    return statusOfError(err);
  }
}

export function deleteLocalTargets(
  deviceId: string,
  rootPath: string,
  targets: readonly DeleteTarget[]
): Promise<FileOpResult<DeleteOutcome>> {
  return enqueueDeviceJob(deviceId, async () => {
    let realRoot: string;
    try {
      realRoot = realpathSync(rootPath);
    } catch {
      return fail('root_not_found');
    }
    const outcome: DeleteOutcome = new Map();
    for (const item of targets) outcome.set(item.index, deleteLocalOne(realRoot, item.path));
    return ok(outcome);
  });
}
