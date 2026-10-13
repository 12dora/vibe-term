// 设备分组列表的通用 UI：只认 `DeviceFolderLayout`、节点 id 与宿主给的 `renderNode`，
// 不知道设备这个业务概念，宿主（apps/fe）负责把节点渲染成分组头 + 卡片网格。
//
// 落点判定全部在 `folder-tree-model.ts` / `collision.ts`（纯函数，有单测），本文件只做交互与
// 呈现：命中高亮、折叠分组的悬停自动展开、跟手的卡片式拖拽预览、就地重命名 / 新建 / 删除确认，
// 以及拖拽过程中的「腾位置」预览（状态在 `use-tree-drag.ts`，呈现在 `node-list.tsx`）：
//   - 预览就是松手之后的真实排布。同容器重排把被拖节点（变暗）直接摆到落点；跨容器时被拖的
//     节点**留在原容器**（变暗，子树不重挂），目标容器里摆一条同跨度、等高的占位条。兄弟由
//     网格真实回流让位，位置变化带 FLIP 过渡；松手才真的提交。
//   - 键盘拖拽的同容器重排仍用 sortable 的位移预览（落点矩形不动，方向键的判定才稳定）。
//
// 版式（节点磁贴网格，规则在 `node-grid.ts`，实现在 `node-list.tsx`）：
//   - 分组始终整行宽、上下排列；根层与每个分组内部各有一张节点网格，列数跟**容器宽度**走
//     （不足 48rem 一列 / 48rem 起两列 / 80rem 起三列）。
//   - 节点磁贴的跨度 = min(设备数, 列数)：单设备节点占一格，N 台设备的节点占 N 格（封顶为
//     当前列数），里面的设备卡片并排铺开。设备数由宿主经 `nodeSpan` 给。
//   - 顺序不重排：视觉顺序永远等于数据顺序，行尾放不下就整块换行，空着的格子不回填。
//
// 移到最外层没有按钮也没有落点条：整棵树本身就是一个落点区，把节点拖到所有分组虚线框
// 之外的空白处松手即回到根层；指针离开整棵树（`over` 为空）则视为取消。

import { DndContext, DragOverlay, MeasuringStrategy, useDndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { type DeviceFolder, type DeviceFolderLayout, countFolderItems } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import { Folder, Server } from 'lucide-react';
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceTreeSensors } from '../device-tree/device-tree-dnd-impl';
import { createDeviceFolderCollisionDetection } from './collision';
import { useDropZone } from './drop-zone';
import { FolderDeleteDialog } from './folder-delete-dialog';
import { FolderNameEditor } from './folder-name-editor';
import { FolderSection } from './folder-section';
import {
  type DeviceFolderDrop,
  ROOT_CONTAINER_ID,
  dropZoneId,
  folderContainerId,
  listContainers,
  parseFolderElementId,
  parseNodeElementId,
  rootFolderElementIds,
} from './folder-tree-model';
import { deviceFolderKeyboardCoordinates } from './keyboard-coordinates';
import type { NodeTileSize } from './node-grid';
import { NodeList } from './node-list';
import { snapCenterToCursor } from './snap-to-cursor';
import {
  type DeviceFolderNodeContext,
  TreeContext,
  type TreeContextValue,
  useTree,
} from './tree-context';
import { FREEZE_HEIGHT_ATTR, useFrozenHeights } from './use-frozen-heights';
import { reflowSignals, useTreeDrag } from './use-tree-drag';

export type { DeviceFolderNodeContext } from './tree-context';

/** 分组展开 / 收起后隔多久补量：等高度过渡走完 */
const REMEASURE_SETTLE_MS = 250;

/**
 * 拖拽中条目换了位置（只是挪动，尺寸没变）时 dnd-kit 不会重量落点矩形，碰撞判定就还在用
 * 回流之前的排布。预览每变一次就让它把全部落点重量一遍（量的是去掉条目自身 transform 的
 * 布局矩形，回流过渡在飞也不影响）；分组展开态变了则等过渡走完再量。信号见 `reflowSignals`。
 */
function RemeasureOnReflow({ reflow, expand }: { reflow: string; expand: string }) {
  const { measureDroppableContainers } = useDndContext();
  useEffect(() => {
    if (reflow) measureDroppableContainers([]);
  }, [reflow, measureDroppableContainers]);
  // 只在拖拽途中展开态**变了**才排延时补量；刚开始拖的那一次不算
  const expandRef = useRef('');
  useEffect(() => {
    const changed = expandRef.current !== '' && expand !== '' && expandRef.current !== expand;
    expandRef.current = expand;
    if (!changed) return;
    const timer = setTimeout(() => measureDroppableContainers([]), REMEASURE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [expand, measureDroppableContainers]);
  return null;
}

export interface DeviceFolderTreeHandle {
  /** 在列表末尾插入一行处于编辑态的新建分组（顶栏按钮用） */
  startNewFolder(): void;
}

export interface DeviceFolderTreeProps {
  layout: DeviceFolderLayout;
  /** 没有 placement 的根层节点，按宿主给的顺序追加在显式节点之后 */
  implicitRootNodeIds: readonly string[];
  renderNode: (nodeId: string, ctx: DeviceFolderNodeContext) => ReactNode;
  /** 拖拽预览卡片上显示的节点名称（无障碍播报仍是 dnd-kit 的默认文案，没有接这个名称） */
  nodeLabel: (nodeId: string) => string;
  /** 返回 false 的节点不套拖拽外壳（该节点本来就不该被拖，如 standalone 下唯一的本机） */
  nodeDraggable?: (nodeId: string, ctx: { folderId: string | null }) => boolean;
  /**
   * 节点磁贴在所在网格里想占几列（通常 = `nodeTileSpan(设备数)`）；`full` 独占整行。
   * 缺省一列。拖拽占位条也用被拖节点的这个值。
   */
  nodeSpan?: (nodeId: string, ctx: { folderId: string | null }) => NodeTileSize;
  /** 分组展开态；缺键视为展开 */
  expanded: Record<string, boolean>;
  onExpandedChange: (folderId: string, expanded: boolean) => void;
  onDrop: (drop: DeviceFolderDrop) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  /** 上一次布局提交还在飞：禁用拖拽，避免先发后到的旧顺序覆盖新顺序 */
  disabled?: boolean;
  className?: string;
  ref?: Ref<DeviceFolderTreeHandle>;
}

function FolderNode({ folder }: { folder: DeviceFolder }) {
  const tree = useTree();
  const { actions, expandedOf, itemCounts, dropContainerId } = tree;
  const containerId = folderContainerId(folder.id);

  return (
    <FolderSection
      folder={folder}
      itemCount={itemCounts.get(folder.id) ?? 0}
      expanded={expandedOf(folder.id)}
      renaming={tree.renamingFolderId === folder.id}
      dragDisabled={tree.dragDisabled}
      dropTarget={dropContainerId === containerId}
      onToggle={(next) => actions.toggle(folder.id, next)}
      onStartRename={() => actions.startRename(folder.id)}
      onSubmitRename={(name) => actions.submitRename(folder.id, name)}
      onCancelRename={actions.cancelRename}
      onDelete={() => actions.requestDelete(folder)}
    >
      <NodeList containerId={containerId} />
    </FolderSection>
  );
}

/**
 * 拖拽预览：一张紧凑的「节点头卡片」，宽度贴近真实分组头（最宽 20rem）。
 * overlay 自身用 `fit-content` 收紧，配合 `snapCenterToCursor` 吸在指针上——
 * 否则 dnd-kit 会按被拖元素（整行的节点分组）的矩形摆放，预览会跑到离手很远的地方。
 */
function DragPreview({ activeId }: { activeId: string }) {
  const { t } = useTranslation();
  const { foldersById, itemCounts, nodeLabel } = useTree();
  const folderId = parseFolderElementId(activeId);
  const folder = folderId ? foldersById.get(folderId) : undefined;
  const nodeId = folderId === null ? parseNodeElementId(activeId) : null;

  return (
    <div
      data-testid="device-folder-drag-preview"
      className="pointer-events-none flex w-max min-w-40 max-w-80 items-center gap-2 rounded-xl border border-border/70 bg-card px-3 py-2 text-sm text-card-foreground shadow-2xl ring-1 ring-ring/20 scale-[1.03] motion-reduce:scale-100"
    >
      {folder ? (
        <>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
            <Folder className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
          <span className="shrink-0 rounded border border-border/60 px-1.5 py-px text-[10px] leading-none text-muted-foreground">
            {t('devices.folders.itemCount', { count: itemCounts.get(folder.id) ?? 0 })}
          </span>
        </>
      ) : nodeId ? (
        <>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
            <Server className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{nodeLabel(nodeId)}</span>
        </>
      ) : null}
    </div>
  );
}

/** 整棵树 = 根落点区：分组虚线框之外的空白都能接住节点，松手即回到最外层 */
function TreeRoot({
  active,
  frozen,
  className,
  children,
}: {
  active: boolean;
  /** 拖拽中 / 定格中：冻结整棵树与各节点网格的高度 */
  frozen: boolean;
  className?: string;
  children: ReactNode;
}) {
  const zone = useDropZone(dropZoneId(ROOT_CONTAINER_ID));
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFrozenHeights(rootRef, frozen);
  const { ref: zoneRef } = zone;
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      zoneRef(element);
    },
    [zoneRef]
  );
  const freeze = { [FREEZE_HEIGHT_ATTR]: '' };
  return (
    <div
      ref={setRef}
      {...zone.props}
      {...freeze}
      data-testid="device-folder-tree"
      data-drop-target={active ? 'true' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl transition-[box-shadow] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
        active && 'ring-2 ring-ring/25',
        className
      )}
    >
      {children}
    </div>
  );
}

export function DeviceFolderTree(props: DeviceFolderTreeProps) {
  const {
    layout,
    implicitRootNodeIds,
    renderNode,
    nodeDraggable,
    nodeSpan,
    nodeLabel,
    expanded,
    onExpandedChange,
    onDrop,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    disabled = false,
    className,
    ref,
  } = props;
  const sensors = useDeviceTreeSensors({
    keyboardCoordinateGetter: deviceFolderKeyboardCoordinates,
  });

  // 指针迟滞与键盘落点的锁都带状态（见 `collision.ts`），每棵树一份，每次拖拽开始时清空
  const collision = useMemo(() => createDeviceFolderCollisionDetection(), []);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<DeviceFolder | null>(null);

  const containers = useMemo(
    () => listContainers(layout, implicitRootNodeIds),
    [layout, implicitRootNodeIds]
  );
  const placedNodeIds = useMemo<ReadonlySet<string>>(
    () => new Set(layout.placements.map((placement) => placement.nodeId)),
    [layout.placements]
  );
  const folderElementIds = useMemo(() => rootFolderElementIds(layout), [layout]);
  const foldersById = useMemo(
    () => new Map(layout.folders.map((folder) => [folder.id, folder])),
    [layout.folders]
  );
  const itemCounts = useMemo(() => countFolderItems(layout), [layout]);

  const expandedOf = useCallback((folderId: string) => expanded[folderId] !== false, [expanded]);
  const spanOf = useCallback(
    (nodeId: string, folderId: string | null) => nodeSpan?.(nodeId, { folderId }) ?? 1,
    [nodeSpan]
  );

  useImperativeHandle(ref, () => ({ startNewFolder: () => setCreatingFolder(true) }), []);

  const drag = useTreeDrag({
    layout,
    implicitRootNodeIds,
    containers,
    expanded,
    onExpandedChange,
    onDrop,
    disabled,
  });
  const { activeId, dropContainerId, placeholder, reorder, reflow, tracking } = drag;
  const signals = reflowSignals(drag, expanded);

  const actions = useMemo<TreeContextValue['actions']>(
    () => ({
      toggle: (folderId, next) => onExpandedChange(folderId, next),
      startRename: (folderId) => {
        setCreatingFolder(false);
        setRenamingFolderId(folderId);
      },
      submitRename: (folderId, name) => {
        setRenamingFolderId(null);
        const current = foldersById.get(folderId);
        if (current && current.name === name) return;
        onRenameFolder(folderId, name);
      },
      cancelRename: () => setRenamingFolderId(null),
      submitNewFolder: (name) => {
        setCreatingFolder(false);
        onCreateFolder(name);
      },
      cancelNewFolder: () => setCreatingFolder(false),
      requestDelete: (folder) => setDeleteCandidate(folder),
    }),
    [foldersById, onCreateFolder, onExpandedChange, onRenameFolder]
  );

  const contextValue = useMemo<TreeContextValue>(
    () => ({
      containers,
      foldersById,
      itemCounts,
      placedNodeIds,
      expandedOf,
      dropContainerId,
      placeholder,
      reorder,
      reflow,
      flipTracking: tracking,
      dragDisabled: disabled,
      creatingFolder,
      renamingFolderId,
      renderNode,
      nodeDraggable,
      nodeLabel,
      nodeSpan: spanOf,
      actions,
    }),
    [
      containers,
      foldersById,
      itemCounts,
      placedNodeIds,
      expandedOf,
      dropContainerId,
      placeholder,
      reorder,
      reflow,
      tracking,
      disabled,
      creatingFolder,
      renamingFolderId,
      renderNode,
      nodeDraggable,
      nodeLabel,
      spanOf,
      actions,
    ]
  );

  return (
    <TreeContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision.detect}
        // 落点矩形在拖拽前后都保持有效；拖拽中条目挪位置（占位条、同容器回流、分组自动展开）
        // 不会触发 dnd-kit 自己重量，由 `RemeasureOnReflow` 在每次回流后补量
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(event) => {
          collision.reset();
          drag.onDragStart(event);
        }}
        onDragOver={drag.onDragOver}
        onDragCancel={drag.onDragCancel}
        onDragEnd={drag.onDragEnd}
      >
        <RemeasureOnReflow reflow={signals.reflow} expand={signals.expand} />
        <TreeRoot active={drag.rootDropActive} frozen={tracking} className={className}>
          {folderElementIds.length > 0 && (
            <SortableContext
              items={folderElementIds}
              strategy={verticalListSortingStrategy}
              disabled={disabled}
            >
              <div className="flex min-w-0 flex-col gap-3">
                {folderElementIds.map((elementId) => {
                  const folderId = parseFolderElementId(elementId);
                  const folder = folderId ? foldersById.get(folderId) : undefined;
                  if (!folder) return null;
                  return <FolderNode key={elementId} folder={folder} />;
                })}
              </div>
            </SortableContext>
          )}

          {creatingFolder && (
            <FolderNameEditor
              testId="device-folder-new"
              className="min-w-0"
              onSubmit={actions.submitNewFolder}
              onCancel={actions.cancelNewFolder}
            />
          )}

          <NodeList containerId={ROOT_CONTAINER_ID} />
        </TreeRoot>
        <DragOverlay
          dropAnimation={null}
          modifiers={[snapCenterToCursor]}
          // overlay 默认撑成被拖元素的大小（整行的节点分组）：收紧成内容宽高，
          // 碰撞矩形也随之变成这张小卡片，落点判定与视觉一致。
          style={{ width: 'fit-content', height: 'fit-content' }}
        >
          {activeId !== null && <DragPreview activeId={activeId} />}
        </DragOverlay>
      </DndContext>

      <FolderDeleteDialog
        folder={deleteCandidate}
        onConfirm={onDeleteFolder}
        onClose={() => setDeleteCandidate(null)}
      />
    </TreeContext.Provider>
  );
}
