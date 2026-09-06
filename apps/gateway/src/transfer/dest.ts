// 目标侧的落点解析：把 `destPath + relPath` 收敛到 destRoot 内的绝对路径，
// 并按设备类型决定字节先落在哪（本机直接落到目标旁的 `.part`，ssh 设备先本机暂存再推）。

import { mkdir } from 'node:fs/promises';
import type { Device, FileErrorCode } from '@tmex/shared';
import { getDeviceById } from '../db';
import { type FileRootRecord, getFileRootById } from '../db/file-roots';
import { checkAndNormalize } from '../files/device-storage';

export interface DestContext {
  root: FileRootRecord;
  device: Device;
  /** 已校验过、落在 root 内的目标目录 */
  destDir: string;
}

export type DestResult<T> = { ok: true; data: T } | { ok: false; code: FileErrorCode };

function fail<T>(code: FileErrorCode): DestResult<T> {
  return { ok: false, code };
}

export function resolveDestContext(destRootId: string, destPath: string): DestResult<DestContext> {
  const root = getFileRootById(destRootId);
  if (!root) return fail('root_not_found');
  if (!root.enabled) return fail('root_disabled');
  const device = getDeviceById(root.deviceId);
  if (!device) return fail('device_not_found');
  const norm = checkAndNormalize(device, root.path, destPath);
  if (!norm.ok) return fail(norm.code);
  return { ok: true, data: { root, device, destDir: norm.path } };
}

/** 相对路径消毒：不接受绝对路径、`..`、空段与 NUL，避免越出 destDir。 */
export function normalizeRelPath(relPath: string): string | null {
  if (!relPath || relPath.includes('\0') || relPath.startsWith('/')) return null;
  const parts: string[] = [];
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

export function joinPosix(dir: string, rel: string): string {
  return dir.endsWith('/') ? `${dir}${rel}` : `${dir}/${rel}`;
}

export function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export function baseNameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * 本机设备：在目标目录里按需建父目录，再复核父目录仍落在 root 内
 * （建目录后才能 realpath，符号链接逃逸只有这时候查得出来）。
 */
export async function ensureLocalParent(
  ctx: DestContext,
  absPath: string
): Promise<DestResult<string>> {
  const parent = parentOf(absPath);
  try {
    await mkdir(parent, { recursive: true });
  } catch {
    return fail('permission_denied');
  }
  const norm = checkAndNormalize(ctx.device, ctx.root.path, parent);
  if (!norm.ok) return fail(norm.code);
  return { ok: true, data: absPath };
}
