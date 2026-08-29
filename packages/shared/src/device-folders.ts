// 设备分组的纯逻辑：gateway 校验与前端乐观更新共用，保证两侧对「合法布局」的判断一致。

import {
  DEVICE_FOLDER_NAME_MAX_LENGTH,
  type DeviceFolder,
  type DeviceFolderLayout,
  type DeviceFolderPlacement,
} from './contracts/device-folders';

export type DeviceFolderNameError = 'empty' | 'tooLong';

export function normalizeDeviceFolderName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function validateDeviceFolderName(
  name: string
): { ok: true; name: string } | { ok: false; error: DeviceFolderNameError } {
  const normalized = normalizeDeviceFolderName(name);
  if (!normalized) return { ok: false, error: 'empty' };
  if ([...normalized].length > DEVICE_FOLDER_NAME_MAX_LENGTH)
    return { ok: false, error: 'tooLong' };
  return { ok: true, name: normalized };
}

/** placement 在库里的主键：与旧数据兼容，仍写成 `node:<nodeId>` */
export function deviceFolderPlacementKey(nodeId: string): string {
  return `node:${nodeId}`;
}

/** 分组列表是否合法：id 唯一即可（分组只有一层，不存在层级关系） */
export function isFolderListValid(folders: readonly Pick<DeviceFolder, 'id'>[]): boolean {
  const ids = new Set(folders.map((folder) => folder.id));
  return ids.size === folders.length;
}

/**
 * 整份布局是否合法：分组 id 唯一、placement 的 nodeId 唯一、folderId 指向存在的分组。
 * 前端乐观更新与 gateway / DB helper 都以此为准，绕过 HTTP 直接写库也会被 helper 拦下。
 */
export function isDeviceFolderLayoutValid(layout: {
  folders: readonly Pick<DeviceFolder, 'id'>[];
  placements: readonly DeviceFolderPlacement[];
}): boolean {
  if (!isFolderListValid(layout.folders)) return false;
  const folderIds = new Set(layout.folders.map((folder) => folder.id));
  const nodeIds = new Set<string>();
  for (const placement of layout.placements) {
    if (!placement.nodeId || nodeIds.has(placement.nodeId)) return false;
    nodeIds.add(placement.nodeId);
    if (placement.folderId !== null && !folderIds.has(placement.folderId)) return false;
    if (!Number.isInteger(placement.sortOrder)) return false;
  }
  return true;
}

function byOrder<T extends { sortOrder: number }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder;
}

/** 分组按 sortOrder 重编号为 0..n-1；每个容器内的 placement 各自独立编号 */
export function normalizeFolderLayoutOrder(layout: DeviceFolderLayout): DeviceFolderLayout {
  const folders = [...layout.folders].sort(byOrder).map((folder, index) => ({
    ...folder,
    sortOrder: index,
  }));
  const groups = new Map<string | null, DeviceFolderPlacement[]>();
  for (const placement of layout.placements) {
    const group = groups.get(placement.folderId) ?? [];
    group.push(placement);
    groups.set(placement.folderId, group);
  }
  const placements: DeviceFolderPlacement[] = [];
  for (const group of groups.values()) {
    group.sort(byOrder).forEach((item, index) => placements.push({ ...item, sortOrder: index }));
  }
  return { folders, placements };
}

/** 删除分组：其中的节点回到根层显式排序，排在根层现有内容之后。 */
export function reparentOnFolderDelete(
  layout: DeviceFolderLayout,
  folderId: string
): DeviceFolderLayout {
  if (!layout.folders.some((folder) => folder.id === folderId)) return layout;
  const rootMax = Math.max(
    -1,
    ...layout.placements
      .filter((placement) => placement.folderId === null)
      .map((placement) => placement.sortOrder)
  );
  const folders = layout.folders.filter((folder) => folder.id !== folderId);
  const placements = layout.placements.map((placement) =>
    placement.folderId === folderId
      ? { ...placement, folderId: null, sortOrder: rootMax + 1 + placement.sortOrder }
      : placement
  );
  return normalizeFolderLayoutOrder({ folders, placements });
}

function insertAt<T extends { sortOrder: number }>(
  siblings: readonly T[],
  moved: T,
  index: number | null
): T[] {
  const sorted = [...siblings].sort(byOrder);
  const at = index === null ? sorted.length : Math.max(0, Math.min(index, sorted.length));
  sorted.splice(at, 0, moved);
  return sorted.map((item, i) => ({ ...item, sortOrder: i }));
}

/** 把分组移到列表的 index 位置（null = 末尾）。分组不存在返回 null。 */
export function moveFolderInLayout(
  layout: DeviceFolderLayout,
  folderId: string,
  index: number | null
): DeviceFolderLayout | null {
  const target = layout.folders.find((folder) => folder.id === folderId);
  if (!target) return null;
  const others = layout.folders.filter((folder) => folder.id !== folderId);
  return normalizeFolderLayoutOrder({
    folders: insertAt(others, target, index),
    placements: layout.placements,
  });
}

/**
 * 把节点移到 targetFolderId（null = 根层显式排序）下的 index 位置（null = 末尾）。
 * 节点原先没有 placement（隐式根层）时视为新增。目标分组不存在返回 null。
 */
export function moveNodeInLayout(
  layout: DeviceFolderLayout,
  nodeId: string,
  targetFolderId: string | null,
  index: number | null
): DeviceFolderLayout | null {
  if (!nodeId) return null;
  if (targetFolderId !== null && !layout.folders.some((folder) => folder.id === targetFolderId)) {
    return null;
  }
  const others = layout.placements.filter((placement) => placement.nodeId !== nodeId);
  const siblings = others.filter((placement) => placement.folderId === targetFolderId);
  const rest = others.filter((placement) => placement.folderId !== targetFolderId);
  const moved: DeviceFolderPlacement = { nodeId, folderId: targetFolderId, sortOrder: 0 };
  const placed = insertAt(siblings, moved, index);
  return normalizeFolderLayoutOrder({ folders: layout.folders, placements: [...rest, ...placed] });
}

/** 把节点从分组里拿出来，回到隐式根层（删除其 placement） */
export function removeNodeFromLayout(
  layout: DeviceFolderLayout,
  nodeId: string
): DeviceFolderLayout {
  return {
    folders: layout.folders,
    placements: layout.placements.filter((placement) => placement.nodeId !== nodeId),
  };
}

/** 节点当前所在分组 id；无 placement 或 placement 指向根返回 null */
export function findNodeFolderId(layout: DeviceFolderLayout, nodeId: string): string | null {
  return layout.placements.find((placement) => placement.nodeId === nodeId)?.folderId ?? null;
}

/** 每个分组里的节点数 */
export function countFolderItems(layout: DeviceFolderLayout): Map<string, number> {
  const counts = new Map<string, number>(layout.folders.map((folder) => [folder.id, 0]));
  for (const placement of layout.placements) {
    if (placement.folderId === null) continue;
    const current = counts.get(placement.folderId);
    if (current !== undefined) counts.set(placement.folderId, current + 1);
  }
  return counts;
}
