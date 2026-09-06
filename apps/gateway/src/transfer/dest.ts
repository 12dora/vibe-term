// 目标侧的落点解析：把 `destPath + relPath` 收敛到**授权目录**内的绝对路径。
// 边界不是 root 而是 grant 绑定的那个目录——root 内的一条符号链接同样不允许写出去。

import { realpathSync } from 'node:fs';
import type { Device, FileErrorCode } from '@tmex/shared';
import { getDeviceById } from '../db';
import type { FileRootRecord } from '../db/file-roots';
import { checkAndNormalize } from '../files/device-storage';
import { resolveFileRoot } from '../files/file-root';

export interface DestContext {
  root: FileRootRecord;
  device: Device;
  /** 已校验过、落在 root 内的目标目录（词法规范化） */
  destDir: string;
  /**
   * 授权边界：本机设备为 `destDir` 的 realpath，所有落点都从这里逐段下探；
   * ssh 设备在本机解不出真实路径，置为 `destDir`，真实边界由远端一次性核对（见 dest-remote）。
   */
  realDestDir: string;
}

export type DestResult<T> = { ok: true; data: T } | { ok: false; code: FileErrorCode };

export function destFail<T>(code: FileErrorCode): DestResult<T> {
  return { ok: false, code };
}

export function resolveDestContext(destRootId: string, destPath: string): DestResult<DestContext> {
  const resolved = resolveFileRoot(destRootId);
  if (!resolved.ok) return destFail(resolved.code);
  const root = resolved.root;
  const device = getDeviceById(root.deviceId);
  if (!device) return destFail('device_not_found');
  const norm = checkAndNormalize(device, root.path, destPath);
  if (!norm.ok) return destFail(norm.code);
  if (device.type !== 'local') {
    return { ok: true, data: { root, device, destDir: norm.path, realDestDir: norm.path } };
  }
  let realDestDir: string;
  try {
    realDestDir = realpathSync(norm.path);
  } catch {
    return destFail('not_found');
  }
  return { ok: true, data: { root, device, destDir: norm.path, realDestDir } };
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

/** 拆成「父目录各段 + 末段」，两侧都按 `normalizeRelPath` 的结果切。 */
export function splitRelPath(rel: string): { dirs: string[]; name: string } {
  const parts = rel.split('/');
  const name = parts.pop() ?? '';
  return { dirs: parts, name };
}
