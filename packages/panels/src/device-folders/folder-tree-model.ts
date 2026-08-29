// 分组列表的容器 / 落点模型：把 `DeviceFolderLayout` + 宿主给出的隐式根节点摊平成
// 「每个容器的有序节点 id」，并把一次 dnd 的 (active, over) 翻译成布局变更。
// 布局本身的合法性与重排全部复用 `@tmex/shared` 的纯函数，这里只负责 id 编解码与落点判定。
//
// 分组只有一层：分组只能在根层彼此排序；节点只能在根层与分组之间移动。设备不是本模型的
// 条目——它永远跟着自己的节点走，节点内的顺序由设备自己的 sortOrder 决定。

import {
  type DeviceFolderLayout,
  type DeviceFolderPlacement,
  moveFolderInLayout,
  moveNodeInLayout,
} from '@tmex/shared';

/** 根容器 id；分组容器为 `folder:<id>` */
export const ROOT_CONTAINER_ID = 'root';

const FOLDER_PREFIX = 'folder:';
const NODE_PREFIX = 'node:';
const DROP_PREFIX = 'drop:';
const DROP_BODY_PREFIX = 'dropin:';

export function folderElementId(folderId: string): string {
  return `${FOLDER_PREFIX}${folderId}`;
}

/** 分组元素 id → 分组 id；不是分组元素返回 null */
export function parseFolderElementId(elementId: string): string | null {
  return elementId.startsWith(FOLDER_PREFIX) ? elementId.slice(FOLDER_PREFIX.length) || null : null;
}

export function nodeElementId(nodeId: string): string {
  return `${NODE_PREFIX}${nodeId}`;
}

/** 节点元素 id → 节点 id；不是节点元素返回 null */
export function parseNodeElementId(elementId: string): string | null {
  return elementId.startsWith(NODE_PREFIX) ? elementId.slice(NODE_PREFIX.length) || null : null;
}

export function folderContainerId(folderId: string | null): string {
  return folderId === null ? ROOT_CONTAINER_ID : folderElementId(folderId);
}

/** 容器 id → 分组 id（根为 null）；非法容器 id 返回 undefined */
export function containerFolderId(containerId: string): string | null | undefined {
  if (containerId === ROOT_CONTAINER_ID) return null;
  return parseFolderElementId(containerId) ?? undefined;
}

/** 容器的放置区（分组头 / 根层「移到最外层」落点条）的 droppable id */
export function dropZoneId(containerId: string): string {
  return `${DROP_PREFIX}${containerId}`;
}

/**
 * 同一个容器的第二个放置区（空分组内容区）。droppable id 全局唯一，空分组的头部与
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
  /** 节点元素 id，按 sortOrder；根容器里显式 placement 在前，隐式节点在后 */
  nodeIds: string[];
}

function byOrder(a: { sortOrder: number }, b: { sortOrder: number }): number {
  return a.sortOrder - b.sortOrder;
}

/** 没有 placement 的候选节点（宿主决定候选集与它们之间的默认顺序） */
export function implicitRootNodeIds(
  layout: DeviceFolderLayout,
  candidates: readonly string[]
): string[] {
  const placed = new Set(layout.placements.map((placement) => placement.nodeId));
  return candidates.filter((nodeId) => !placed.has(nodeId));
}

/** 根层分组的元素 id，按 sortOrder */
export function rootFolderElementIds(layout: DeviceFolderLayout): string[] {
  return [...layout.folders].sort(byOrder).map((folder) => folderElementId(folder.id));
}

/**
 * 每个容器的有序节点。隐式根节点只影响根容器，且永远排在显式 placement 之后。
 * folderId 指向不存在分组的孤儿 placement 被忽略（服务端不会产生，手改库时兜底）。
 */
export function listContainers(
  layout: DeviceFolderLayout,
  implicit: readonly string[] = []
): Map<string, DeviceFolderContainer> {
  const containers = new Map<string, DeviceFolderContainer>();
  const ensure = (folderId: string | null): DeviceFolderContainer => {
    const containerId = folderContainerId(folderId);
    let container = containers.get(containerId);
    if (!container) {
      container = { containerId, folderId, nodeIds: [] };
      containers.set(containerId, container);
    }
    return container;
  };

  ensure(null);
  const knownFolderIds = new Set(layout.folders.map((folder) => folder.id));
  for (const folder of layout.folders) ensure(folder.id);
  for (const placement of [...layout.placements].sort(byOrder)) {
    if (placement.folderId !== null && !knownFolderIds.has(placement.folderId)) continue;
    ensure(placement.folderId).nodeIds.push(nodeElementId(placement.nodeId));
  }
  const root = ensure(null);
  for (const nodeId of implicit) root.nodeIds.push(nodeElementId(nodeId));
  return containers;
}

function locateNode(
  containers: Map<string, DeviceFolderContainer>,
  elementId: string
): { containerId: string; index: number } | null {
  for (const container of containers.values()) {
    const index = container.nodeIds.indexOf(elementId);
    if (index >= 0) return { containerId: container.containerId, index };
  }
  return null;
}

export type DeviceFolderDrop =
  | { kind: 'folder'; folderId: string; index: number | null }
  | { kind: 'node'; nodeId: string; targetFolderId: string | null; index: number | null };

/**
 * 只解析落点：
 *  - 分组只能在根层重排：落在别的分组头上 = 插到它的位置；落在根层落点条上 = 排到末尾；
 *    落在节点 / 分组内容区上一律无效（分组不能进分组）。
 *  - 节点：落在放置区上 = 追加到该容器末尾；落在分组头上 = 放进该分组末尾；
 *    落在别的节点上 = 插到该节点所在容器的这个位置。
 * 无效落点返回 null。
 */
export function resolveDrop(
  activeId: string,
  overId: string,
  layout: DeviceFolderLayout,
  implicit: readonly string[] = []
): DeviceFolderDrop | null {
  if (activeId === overId) return null;
  const activeFolderId = parseFolderElementId(activeId);
  if (activeFolderId !== null) {
    if (!layout.folders.some((folder) => folder.id === activeFolderId)) return null;
    const overZone = parseDropZoneId(overId);
    if (overZone === ROOT_CONTAINER_ID) {
      return { kind: 'folder', folderId: activeFolderId, index: null };
    }
    // 落在别的分组头（`drop:` 放置区）上与落在分组元素上同义：插到那个分组的位置；
    // 分组内容区（`dropin:`）不是分组的落点（分组不能进分组）
    const overFolderId = parseFolderElementId(
      overZone !== null ? (overId.startsWith(DROP_PREFIX) ? overZone : '') : overId
    );
    if (overFolderId === null || overFolderId === activeFolderId) return null;
    const index = rootFolderElementIds(layout).indexOf(folderElementId(overFolderId));
    if (index < 0) return null;
    return { kind: 'folder', folderId: activeFolderId, index };
  }

  const activeNodeId = parseNodeElementId(activeId);
  if (activeNodeId === null) return null;
  const containers = listContainers(layout, implicit);

  let targetContainerId: string;
  let index: number | null;
  const zoneContainerId = parseDropZoneId(overId);
  const overFolderId = zoneContainerId === null ? parseFolderElementId(overId) : null;
  if (zoneContainerId !== null) {
    targetContainerId = zoneContainerId;
    index = null;
  } else if (overFolderId !== null) {
    targetContainerId = folderContainerId(overFolderId);
    index = null;
  } else {
    const location = locateNode(containers, overId);
    if (!location) return null;
    targetContainerId = location.containerId;
    index = location.index;
  }

  if (!containers.has(targetContainerId)) return null;
  const targetFolderId = containerFolderId(targetContainerId);
  if (targetFolderId === undefined) return null;
  return { kind: 'node', nodeId: activeNodeId, targetFolderId, index };
}

/**
 * 按拖动对象过滤碰撞候选：拖分组时只看根层的分组元素、分组头放置区与根层落点条（不会落进
 * 节点列表或分组内容区）；拖节点时只看节点元素与放置区（不会与分组元素本体撞车）。
 * 键盘排序同样经此过滤，不会停在无效落点上。
 */
export function collisionCandidateIds(activeId: string, ids: readonly string[]): string[] {
  if (parseFolderElementId(activeId) !== null) {
    return ids.filter((id) => {
      if (id === activeId) return false;
      if (parseFolderElementId(id) !== null) return true;
      const zone = parseDropZoneId(id);
      return (
        zone !== null &&
        (zone === ROOT_CONTAINER_ID || (id.startsWith(DROP_PREFIX) && zone !== ROOT_CONTAINER_ID))
      );
    });
  }
  if (parseNodeElementId(activeId) !== null) {
    return ids.filter(
      (id) => id !== activeId && (parseNodeElementId(id) !== null || parseDropZoneId(id) !== null)
    );
  }
  return [];
}

/** 落点对应的容器 id（拖拽中高亮用）；无效落点返回 null */
export function dropTargetContainerId(drop: DeviceFolderDrop | null): string | null {
  if (!drop) return null;
  return drop.kind === 'folder' ? ROOT_CONTAINER_ID : folderContainerId(drop.targetFolderId);
}

/**
 * 把隐式根节点落成显式 placement（追加在现有根层节点之后，保持宿主给的顺序）。
 * 根层一旦参与排序就必须全部显式化，否则「显式在前、隐式在后」会把刚拖动的节点弹回队首。
 */
export function materializeRootNodes(
  layout: DeviceFolderLayout,
  implicit: readonly string[]
): DeviceFolderLayout {
  const pending = implicitRootNodeIds(layout, implicit);
  if (pending.length === 0) return layout;
  const nextOrder =
    layout.placements
      .filter((placement) => placement.folderId === null)
      .reduce((max, placement) => Math.max(max, placement.sortOrder), -1) + 1;
  const added: DeviceFolderPlacement[] = pending.map((nodeId, offset) => ({
    nodeId,
    folderId: null,
    sortOrder: nextOrder + offset,
  }));
  return { folders: layout.folders, placements: [...layout.placements, ...added] };
}

/** 应用一次落点；非法（目标分组不存在）返回 null */
export function applyDrop(
  layout: DeviceFolderLayout,
  drop: DeviceFolderDrop,
  implicit: readonly string[] = []
): DeviceFolderLayout | null {
  if (drop.kind === 'folder') {
    return moveFolderInLayout(layout, drop.folderId, drop.index);
  }
  const base = drop.targetFolderId === null ? materializeRootNodes(layout, implicit) : layout;
  return moveNodeInLayout(base, drop.nodeId, drop.targetFolderId, drop.index);
}
