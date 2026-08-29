// 设备文件夹树的纯逻辑：gateway 校验与前端乐观更新共用，保证两侧对「合法布局」的判断一致。

import {
  DEVICE_FOLDER_NAME_MAX_LENGTH,
  type DeviceFolder,
  type DeviceFolderItemRef,
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

export function deviceFolderItemKey(ref: DeviceFolderItemRef): string {
  return ref.kind === 'node' ? `node:${ref.nodeId}` : `device:${ref.nodeId}:${ref.deviceId ?? ''}`;
}

export function parseDeviceFolderItemKey(key: string): DeviceFolderItemRef | null {
  const parts = key.split(':');
  if (parts[0] === 'node' && parts.length === 2 && parts[1]) {
    return { kind: 'node', nodeId: parts[1], deviceId: null };
  }
  if (parts[0] === 'device' && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: 'device', nodeId: parts[1], deviceId: parts[2] };
  }
  return null;
}

export function sameDeviceFolderItem(a: DeviceFolderItemRef, b: DeviceFolderItemRef): boolean {
  return (
    a.kind === b.kind && a.nodeId === b.nodeId && (a.deviceId ?? null) === (b.deviceId ?? null)
  );
}

type FolderLink = Pick<DeviceFolder, 'id' | 'parentId'>;

/** 含自身在内的全部后代 id */
export function folderDescendantIds(folders: readonly FolderLink[], folderId: string): Set<string> {
  const childrenOf = new Map<string | null, string[]>();
  for (const folder of folders) {
    const list = childrenOf.get(folder.parentId) ?? [];
    list.push(folder.id);
    childrenOf.set(folder.parentId, list);
  }
  const result = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/** 把 folderId 挂到 newParentId 下会不会成环（挂到自己或自己的后代下） */
export function wouldCreateFolderCycle(
  folders: readonly FolderLink[],
  folderId: string,
  newParentId: string | null
): boolean {
  if (newParentId === null) return false;
  return folderDescendantIds(folders, folderId).has(newParentId);
}

/** 整个文件夹集合是否无环且 parentId 都指向存在的文件夹 */
export function isFolderForestValid(folders: readonly FolderLink[]): boolean {
  const ids = new Set(folders.map((folder) => folder.id));
  if (ids.size !== folders.length) return false;
  const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentId] as const));
  for (const folder of folders) {
    if (folder.parentId !== null && !ids.has(folder.parentId)) return false;
    const seen = new Set<string>();
    let cursor: string | null = folder.id;
    while (cursor !== null) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return true;
}

function byOrder<T extends { sortOrder: number }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder;
}

/** 同一容器内按 sortOrder 重编号为 0..n-1（文件夹与条目各自独立编号） */
export function normalizeFolderLayoutOrder(layout: DeviceFolderLayout): DeviceFolderLayout {
  const renumber = <T extends { sortOrder: number }>(
    list: readonly T[],
    keyOf: (item: T) => string | null
  ): T[] => {
    const groups = new Map<string | null, T[]>();
    for (const item of list) {
      const group = groups.get(keyOf(item)) ?? [];
      group.push(item);
      groups.set(keyOf(item), group);
    }
    const out: T[] = [];
    for (const group of groups.values()) {
      group.sort(byOrder).forEach((item, index) => out.push({ ...item, sortOrder: index }));
    }
    return out;
  };
  return {
    folders: renumber(layout.folders, (folder) => folder.parentId),
    placements: renumber(layout.placements, (placement) => placement.folderId),
  };
}

/**
 * 删除文件夹：子文件夹与其中条目全部上提到被删文件夹的父级（父级为根时条目保留为根层
 * 显式排序），排在父级现有内容之后。
 */
export function reparentOnFolderDelete(
  layout: DeviceFolderLayout,
  folderId: string
): DeviceFolderLayout {
  const target = layout.folders.find((folder) => folder.id === folderId);
  if (!target) return layout;
  const parentId = target.parentId;
  const siblingFolderMax = Math.max(
    -1,
    ...layout.folders
      .filter((folder) => folder.parentId === parentId && folder.id !== folderId)
      .map((folder) => folder.sortOrder)
  );
  const siblingItemMax = Math.max(
    -1,
    ...layout.placements
      .filter((placement) => placement.folderId === parentId)
      .map((placement) => placement.sortOrder)
  );
  const folders = layout.folders
    .filter((folder) => folder.id !== folderId)
    .map((folder) =>
      folder.parentId === folderId
        ? { ...folder, parentId, sortOrder: siblingFolderMax + 1 + folder.sortOrder }
        : folder
    );
  const placements = layout.placements.map((placement) =>
    placement.folderId === folderId
      ? { ...placement, folderId: parentId, sortOrder: siblingItemMax + 1 + placement.sortOrder }
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

/**
 * 移动文件夹到 targetParentId 下的 index 位置（null = 末尾）。成环返回 null。
 */
export function moveFolderInLayout(
  layout: DeviceFolderLayout,
  folderId: string,
  targetParentId: string | null,
  index: number | null
): DeviceFolderLayout | null {
  const target = layout.folders.find((folder) => folder.id === folderId);
  if (!target) return null;
  if (wouldCreateFolderCycle(layout.folders, folderId, targetParentId)) return null;
  if (targetParentId !== null && !layout.folders.some((folder) => folder.id === targetParentId)) {
    return null;
  }
  const others = layout.folders.filter((folder) => folder.id !== folderId);
  const siblings = others.filter((folder) => folder.parentId === targetParentId);
  const rest = others.filter((folder) => folder.parentId !== targetParentId);
  const placed = insertAt(siblings, { ...target, parentId: targetParentId }, index);
  return normalizeFolderLayoutOrder({
    folders: [...rest, ...placed],
    placements: layout.placements,
  });
}

/**
 * 移动条目到 targetFolderId（null = 根层显式排序）下的 index 位置（null = 末尾）。
 * 条目原先没有 placement（隐式根层）时视为新增。目标文件夹不存在返回 null。
 */
export function moveItemInLayout(
  layout: DeviceFolderLayout,
  item: DeviceFolderItemRef,
  targetFolderId: string | null,
  index: number | null
): DeviceFolderLayout | null {
  if (targetFolderId !== null && !layout.folders.some((folder) => folder.id === targetFolderId)) {
    return null;
  }
  const others = layout.placements.filter((placement) => !sameDeviceFolderItem(placement, item));
  const siblings = others.filter((placement) => placement.folderId === targetFolderId);
  const rest = others.filter((placement) => placement.folderId !== targetFolderId);
  const moved: DeviceFolderPlacement = {
    kind: item.kind,
    nodeId: item.nodeId,
    deviceId: item.kind === 'node' ? null : (item.deviceId ?? null),
    folderId: targetFolderId,
    sortOrder: 0,
  };
  const placed = insertAt(siblings, moved, index);
  return normalizeFolderLayoutOrder({ folders: layout.folders, placements: [...rest, ...placed] });
}

/** 把条目从任何文件夹里拿出来，回到隐式根层（删除其 placement） */
export function removeItemFromLayout(
  layout: DeviceFolderLayout,
  item: DeviceFolderItemRef
): DeviceFolderLayout {
  return {
    folders: layout.folders,
    placements: layout.placements.filter((placement) => !sameDeviceFolderItem(placement, item)),
  };
}

export interface DeviceFolderTreeNode {
  folder: DeviceFolder;
  children: DeviceFolderTreeNode[];
  items: DeviceFolderPlacement[];
  /** 含全部后代的条目数 */
  itemCount: number;
}

export interface DeviceFolderTree {
  roots: DeviceFolderTreeNode[];
  /** 根层显式排序的条目（folderId=null） */
  rootItems: DeviceFolderPlacement[];
  byId: Map<string, DeviceFolderTreeNode>;
}

export function buildDeviceFolderTree(layout: DeviceFolderLayout): DeviceFolderTree {
  const byId = new Map<string, DeviceFolderTreeNode>();
  for (const folder of layout.folders) {
    byId.set(folder.id, { folder, children: [], items: [], itemCount: 0 });
  }
  const roots: DeviceFolderTreeNode[] = [];
  for (const folder of [...layout.folders].sort(byOrder)) {
    const node = byId.get(folder.id) as DeviceFolderTreeNode;
    const parent = folder.parentId === null ? null : byId.get(folder.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const rootItems: DeviceFolderPlacement[] = [];
  for (const placement of [...layout.placements].sort(byOrder)) {
    const node = placement.folderId === null ? null : byId.get(placement.folderId);
    if (node) node.items.push(placement);
    else rootItems.push(placement);
  }
  const count = (node: DeviceFolderTreeNode): number => {
    node.itemCount =
      node.items.length + node.children.reduce((sum, child) => sum + count(child), 0);
    return node.itemCount;
  };
  for (const root of roots) count(root);
  return { roots, rootItems, byId };
}

/** 条目当前所在文件夹 id；无 placement 或 placement 指向根返回 null */
export function findItemFolderId(
  layout: DeviceFolderLayout,
  item: DeviceFolderItemRef
): string | null {
  return (
    layout.placements.find((placement) => sameDeviceFolderItem(placement, item))?.folderId ?? null
  );
}
