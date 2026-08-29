// 文件夹树的容器 / 落点模型：把 `DeviceFolderLayout` + 宿主给出的隐式根条目摊平成
// 「每个容器的有序子元素 id」，并把一次 dnd 的 (active, over) 翻译成布局变更。
// 布局本身的合法性与重排全部复用 `@tmex/shared` 的纯函数，这里只负责 id 编解码与落点判定。

import {
  type DeviceFolderItemRef,
  type DeviceFolderLayout,
  type DeviceFolderPlacement,
  deviceFolderItemKey,
  moveFolderInLayout,
  moveItemInLayout,
  parseDeviceFolderItemKey,
  sameDeviceFolderItem,
  wouldCreateFolderCycle,
} from '@tmex/shared';

/** 根容器 id；文件夹容器为 `folder:<id>` */
export const ROOT_CONTAINER_ID = 'root';

const FOLDER_PREFIX = 'folder:';
const DROP_PREFIX = 'drop:';
const DROP_BODY_PREFIX = 'dropin:';

export function folderElementId(folderId: string): string {
  return `${FOLDER_PREFIX}${folderId}`;
}

/** 文件夹元素 id → 文件夹 id；不是文件夹元素返回 null */
export function parseFolderElementId(elementId: string): string | null {
  return elementId.startsWith(FOLDER_PREFIX) ? elementId.slice(FOLDER_PREFIX.length) || null : null;
}

export function folderContainerId(folderId: string | null): string {
  return folderId === null ? ROOT_CONTAINER_ID : folderElementId(folderId);
}

/** 容器 id → 文件夹 id（根为 null）；非法容器 id 返回 undefined */
export function containerFolderId(containerId: string): string | null | undefined {
  if (containerId === ROOT_CONTAINER_ID) return null;
  return parseFolderElementId(containerId) ?? undefined;
}

/** 容器的放置区（文件夹头 / 根层落点条）的 droppable id */
export function dropZoneId(containerId: string): string {
  return `${DROP_PREFIX}${containerId}`;
}

/**
 * 同一个容器的第二个放置区（空文件夹内容区）。droppable id 全局唯一，空文件夹的头部与
 * 内容区都能接收落点，必须用两个不同的 id 指向同一个容器。
 */
export function bodyDropZoneId(containerId: string): string {
  return `${DROP_BODY_PREFIX}${containerId}`;
}

/** 放置区 id → 容器 id；不是放置区返回 null */
export function parseDropZoneId(id: string): string | null {
  if (id.startsWith(DROP_PREFIX)) return id.slice(DROP_PREFIX.length) || null;
  if (id.startsWith(DROP_BODY_PREFIX)) return id.slice(DROP_BODY_PREFIX.length) || null;
  return null;
}

export interface DeviceFolderContainer {
  containerId: string;
  /** null = 根容器 */
  folderId: string | null;
  /** 子文件夹的元素 id，按 sortOrder */
  folderIds: string[];
  /** 子条目的 key，显式 placement 在前，隐式根条目在后 */
  itemKeys: string[];
}

/** 容器内的全部子元素 id：文件夹在前，条目在后 */
export function containerChildIds(container: DeviceFolderContainer): string[] {
  return [...container.folderIds, ...container.itemKeys];
}

function byOrder(a: { sortOrder: number }, b: { sortOrder: number }): number {
  return a.sortOrder - b.sortOrder;
}

/** 没有 placement 的候选条目（宿主决定候选集与它们之间的默认顺序） */
export function implicitRootItems(
  layout: DeviceFolderLayout,
  candidates: readonly DeviceFolderItemRef[]
): DeviceFolderItemRef[] {
  return candidates.filter(
    (candidate) =>
      !layout.placements.some((placement) => sameDeviceFolderItem(placement, candidate))
  );
}

/**
 * 每个容器的有序子元素。隐式根条目只影响根容器，且永远排在显式 placement 之后。
 * parentId / folderId 指向不存在文件夹的孤儿元素被忽略（服务端不会产生，手改库时兜底）。
 */
export function listContainers(
  layout: DeviceFolderLayout,
  implicit: readonly DeviceFolderItemRef[] = []
): Map<string, DeviceFolderContainer> {
  const containers = new Map<string, DeviceFolderContainer>();
  const ensure = (folderId: string | null): DeviceFolderContainer => {
    const containerId = folderContainerId(folderId);
    let container = containers.get(containerId);
    if (!container) {
      container = { containerId, folderId, folderIds: [], itemKeys: [] };
      containers.set(containerId, container);
    }
    return container;
  };

  ensure(null);
  const knownFolderIds = new Set(layout.folders.map((folder) => folder.id));
  for (const folder of layout.folders) ensure(folder.id);
  for (const folder of [...layout.folders].sort(byOrder)) {
    if (folder.parentId !== null && !knownFolderIds.has(folder.parentId)) continue;
    ensure(folder.parentId).folderIds.push(folderElementId(folder.id));
  }
  for (const placement of [...layout.placements].sort(byOrder)) {
    if (placement.folderId !== null && !knownFolderIds.has(placement.folderId)) continue;
    ensure(placement.folderId).itemKeys.push(deviceFolderItemKey(placement));
  }
  const root = ensure(null);
  for (const item of implicit) root.itemKeys.push(deviceFolderItemKey(item));
  return containers;
}

interface ElementLocation {
  containerId: string;
  /** 在同类列表（文件夹列表 / 条目列表）中的下标 */
  index: number;
  kind: 'folder' | 'item';
}

function locateElement(
  containers: Map<string, DeviceFolderContainer>,
  elementId: string
): ElementLocation | null {
  for (const container of containers.values()) {
    const folderIndex = container.folderIds.indexOf(elementId);
    if (folderIndex >= 0) {
      return { containerId: container.containerId, index: folderIndex, kind: 'folder' };
    }
    const itemIndex = container.itemKeys.indexOf(elementId);
    if (itemIndex >= 0) {
      return { containerId: container.containerId, index: itemIndex, kind: 'item' };
    }
  }
  return null;
}

export type DeviceFolderDrop =
  | { kind: 'folder'; folderId: string; targetFolderId: string | null; index: number | null }
  | {
      kind: 'item';
      item: DeviceFolderItemRef;
      targetFolderId: string | null;
      index: number | null;
    };

export interface DeviceFolderDropTarget {
  targetFolderId: string | null;
  /** null = 追加到末尾 */
  index: number | null;
}

/**
 * 只解析落点位置，**不做成环判定**：UI 需要区分「无效落点」（什么都不做）与
 * 「落到了自己的后代里」（提示 `devices.folders.cycle`）。
 *
 * `overId` 可以是放置区（`drop:<container>`，落到容器末尾）或者某个兄弟元素
 * （插到该元素所在容器的这个位置）。条目落在文件夹行上视为放进那个文件夹；
 * 文件夹落在条目上视为追加到该容器的文件夹列表末尾。
 */
export function resolveDropTarget(
  activeId: string,
  overId: string,
  layout: DeviceFolderLayout,
  implicit: readonly DeviceFolderItemRef[] = []
): DeviceFolderDropTarget | null {
  if (activeId === overId) return null;
  const activeFolderId = parseFolderElementId(activeId);
  const activeItem = activeFolderId === null ? parseDeviceFolderItemKey(activeId) : null;
  if (activeFolderId === null && activeItem === null) return null;

  const containers = listContainers(layout, implicit);
  let targetContainerId: string;
  let index: number | null;

  const zoneContainerId = parseDropZoneId(overId);
  const overFolderId = zoneContainerId === null ? parseFolderElementId(overId) : null;
  if (zoneContainerId !== null) {
    targetContainerId = zoneContainerId;
    index = null;
  } else if (overFolderId !== null && activeItem !== null) {
    // 条目落到文件夹行上：放进这个文件夹的末尾
    targetContainerId = folderContainerId(overFolderId);
    index = null;
  } else {
    const location = locateElement(containers, overId);
    if (!location) return null;
    targetContainerId = location.containerId;
    // 只有同类元素之间才谈得上「插到这个位置」，异类落点一律追加到末尾
    index = location.kind === (activeFolderId !== null ? 'folder' : 'item') ? location.index : null;
  }

  if (!containers.has(targetContainerId)) return null;
  const targetFolderId = containerFolderId(targetContainerId);
  if (targetFolderId === undefined) return null;
  return { targetFolderId, index };
}

/** 落点 + 成环判定；无效落点或把文件夹放进自己 / 后代返回 null */
export function resolveDrop(
  activeId: string,
  overId: string,
  layout: DeviceFolderLayout,
  implicit: readonly DeviceFolderItemRef[] = []
): DeviceFolderDrop | null {
  const target = resolveDropTarget(activeId, overId, layout, implicit);
  if (!target) return null;
  const activeFolderId = parseFolderElementId(activeId);
  if (activeFolderId !== null) {
    if (wouldCreateFolderCycle(layout.folders, activeFolderId, target.targetFolderId)) return null;
    return { kind: 'folder', folderId: activeFolderId, ...target };
  }
  const item = parseDeviceFolderItemKey(activeId);
  if (!item) return null;
  return { kind: 'item', item, ...target };
}

/**
 * 把隐式根条目落成显式 placement（追加在现有根层条目之后，保持宿主给的顺序）。
 * 根层一旦参与排序就必须全部显式化，否则「显式在前、隐式在后」会把刚拖动的条目弹回队首。
 */
export function materializeRootItems(
  layout: DeviceFolderLayout,
  implicit: readonly DeviceFolderItemRef[]
): DeviceFolderLayout {
  const pending = implicitRootItems(layout, implicit);
  if (pending.length === 0) return layout;
  const nextOrder =
    layout.placements
      .filter((placement) => placement.folderId === null)
      .reduce((max, placement) => Math.max(max, placement.sortOrder), -1) + 1;
  const added: DeviceFolderPlacement[] = pending.map((item, offset) => ({
    kind: item.kind,
    nodeId: item.nodeId,
    deviceId: item.kind === 'node' ? null : (item.deviceId ?? null),
    folderId: null,
    sortOrder: nextOrder + offset,
  }));
  return { folders: layout.folders, placements: [...layout.placements, ...added] };
}

/** 应用一次落点；非法（目标文件夹不存在 / 成环）返回 null */
export function applyDrop(
  layout: DeviceFolderLayout,
  drop: DeviceFolderDrop,
  implicit: readonly DeviceFolderItemRef[] = []
): DeviceFolderLayout | null {
  if (drop.kind === 'folder') {
    return moveFolderInLayout(layout, drop.folderId, drop.targetFolderId, drop.index);
  }
  const base = drop.targetFolderId === null ? materializeRootItems(layout, implicit) : layout;
  return moveItemInLayout(base, drop.item, drop.targetFolderId, drop.index);
}

/** 某个 node 上已被单独放置（脱离节点分组）的设备 id */
export function placedDeviceIds(layout: DeviceFolderLayout, nodeId: string): Set<string> {
  const ids = new Set<string>();
  for (const placement of layout.placements) {
    if (placement.kind === 'device' && placement.nodeId === nodeId && placement.deviceId) {
      ids.add(placement.deviceId);
    }
  }
  return ids;
}
