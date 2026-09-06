// rootId → 文件根记录的唯一解析入口。所有按 rootId 取目录的调用（浏览 / 传输 / 上传下载）
// 都必须经过这里，虚拟根 `fs-root` 才不会出现「一处认、另一处不认」的缝。
//
// 虚拟根语义：节点一条启用的白名单根都没有时，`fs-root` 折算成本机设备的 `/`，
// 让传输弹窗至少能浏览起来；只要存在任意一条启用的根，白名单模型立即恢复独占，
// `fs-root` 与任何不存在的 id 一样返回 `root_not_found`。

import { type FileErrorCode, VIRTUAL_FS_ROOT_ID } from '@tmex/shared';
import { getAllDevices } from '../db';
import { type FileRootRecord, getFileRootById, getFileRoots } from '../db/file-roots';

export type ResolveFileRootResult =
  | { ok: true; root: FileRootRecord }
  | { ok: false; code: FileErrorCode };

export function hasEnabledFileRoots(): boolean {
  return getFileRoots().some((root) => root.enabled);
}

function virtualFsRoot(): ResolveFileRootResult {
  if (hasEnabledFileRoots()) return { ok: false, code: 'root_not_found' };
  const device = getAllDevices().find((item) => item.type === 'local');
  if (!device) return { ok: false, code: 'device_not_found' };
  return {
    ok: true,
    root: {
      id: VIRTUAL_FS_ROOT_ID,
      deviceId: device.id,
      path: '/',
      enabled: true,
      sortOrder: 0,
      createdAt: device.createdAt,
    },
  };
}

export function resolveFileRoot(rootId: string): ResolveFileRootResult {
  if (rootId === VIRTUAL_FS_ROOT_ID) return virtualFsRoot();
  const root = getFileRootById(rootId);
  if (!root) return { ok: false, code: 'root_not_found' };
  if (!root.enabled) return { ok: false, code: 'root_disabled' };
  return { ok: true, root };
}
