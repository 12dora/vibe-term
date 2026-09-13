// rootId → 文件根记录的唯一解析入口。所有按 rootId 取目录的调用（浏览 / 传输 / 上传下载）
// 都必须经过这里，虚拟根 `fs-root` / `home-root` 才不会出现「一处认、另一处不认」的缝。
//
// `fs-root`：节点一条启用的白名单根都没有时，折算成本机设备的 `/`；一旦存在启用根即失效。
// `home-root`：绑定本机设备 `$HOME`（realpath），不论是否已有其它根都可解析；
// 用户创建的启用根展示名为 `home` 时，该用户根胜出（resolve 返回用户根，列表不再附带虚拟项）。

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { type FileErrorCode, VIRTUAL_FS_ROOT_ID, VIRTUAL_HOME_ROOT_ID } from '@vibeterm/shared';
import { getAllDevices } from '../db';
import { type FileRootRecord, getFileRootById, getFileRoots } from '../db/file-roots';

export type ResolveFileRootResult =
  | { ok: true; root: FileRootRecord }
  | { ok: false; code: FileErrorCode };

export function hasEnabledFileRoots(): boolean {
  return getFileRoots().some((root) => root.enabled);
}

export function rootDisplayName(p: string): string {
  if (p === '/') return '/';
  const trimmed = p.replace(/\/$/, '');
  const i = trimmed.lastIndexOf('/');
  const base = i >= 0 ? trimmed.slice(i + 1) : trimmed;
  return base || p;
}

function firstLocalDevice(): ReturnType<typeof getAllDevices>[number] | undefined {
  return getAllDevices().find((item) => item.type === 'local');
}

function virtualRecord(
  id: string,
  deviceId: string,
  path: string,
  createdAt: string,
  sortOrder: number
): FileRootRecord {
  return { id, deviceId, path, enabled: true, sortOrder, createdAt };
}

function virtualFsRoot(): ResolveFileRootResult {
  if (hasEnabledFileRoots()) return { ok: false, code: 'root_not_found' };
  const device = firstLocalDevice();
  if (!device) return { ok: false, code: 'device_not_found' };
  return { ok: true, root: virtualRecord(VIRTUAL_FS_ROOT_ID, device.id, '/', device.createdAt, 0) };
}

export function userEnabledRootNamedHome(): FileRootRecord | null {
  return (
    getFileRoots().find((root) => root.enabled && rootDisplayName(root.path) === 'home') ?? null
  );
}

function homeDirRealPath(): string | null {
  try {
    return realpathSync(homedir());
  } catch {
    return null;
  }
}

function synthesizeHomeRoot(): ResolveFileRootResult {
  const device = firstLocalDevice();
  if (!device) return { ok: false, code: 'device_not_found' };
  const path = homeDirRealPath();
  if (!path) return { ok: false, code: 'root_not_found' };
  const persisted = getFileRoots();
  const sortOrder = persisted.length === 0 ? 0 : persisted[persisted.length - 1].sortOrder + 1;
  return {
    ok: true,
    root: virtualRecord(VIRTUAL_HOME_ROOT_ID, device.id, path, device.createdAt, sortOrder),
  };
}

function virtualHomeRoot(): ResolveFileRootResult {
  const shadowed = userEnabledRootNamedHome();
  if (shadowed) return { ok: true, root: shadowed };
  return synthesizeHomeRoot();
}

export function virtualHomeRootForList(): FileRootRecord | null {
  if (userEnabledRootNamedHome()) return null;
  const made = synthesizeHomeRoot();
  return made.ok ? made.root : null;
}

export function resolveFileRoot(rootId: string): ResolveFileRootResult {
  if (rootId === VIRTUAL_FS_ROOT_ID) return virtualFsRoot();
  if (rootId === VIRTUAL_HOME_ROOT_ID) return virtualHomeRoot();
  const root = getFileRootById(rootId);
  if (!root) return { ok: false, code: 'root_not_found' };
  if (!root.enabled) return { ok: false, code: 'root_disabled' };
  return { ok: true, root };
}
