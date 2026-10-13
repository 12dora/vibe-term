// 设备分组列表的通用 UI：只认 `DeviceFolderLayout`、节点 id 与宿主给的 `renderNode`，
// 不知道设备这个业务概念，宿主（apps/fe）负责把节点渲染成分组头 + 卡片网格。
//
// 落点判定全部在 `folder-tree-model.ts` / `collision.ts`（纯函数，有单测），本文件只做交互与
// 呈现：命中高亮、折叠分组的悬停自动展开、跟手的卡片式拖拽预览、就地重命名 / 新建 / 删除确认，
// 以及拖拽过程中的「腾位置」预览——跨容器时被拖的节点**留在原容器**（变暗），目标容器里插一条
// 等高的占位条把兄弟顶开，松手才真的提交。
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

import { DndContext, DragOverlay, MeasuringStrategy } from '@dnd-kit/core';
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
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
import { deviceFolderCollisionDetection } from './collision';
import { useDropZone } from './drop-zone';
import { FolderDeleteDialog } from './folder-delete-dialog';
import { FolderNameEditor } from './folder-name-editor';
import { FolderSection } from './folder-section';
import {
  type DeviceFolderDrop,
  ROOT_CONTAINER_ID,
  containerFolderId,
  dropTargetContainerId,
  dropZoneId,
  folderContainerId,
  listContainers,
  parseFolderElementId,
  parseNodeElementId,
  previewPlaceholder,
  resolveDrop,
  rootFolderElementIds,
} from './folder-tree-model';
import type { NodeTileSize } from './node-grid';
import { NodeList } from './node-list';
import { snapCenterToCursor } from './snap-to-cursor';
import {
  type DeviceFolderNodeContext,
  TreeContext,
  type TreeContextValue,
  useTree,
} from './tree-context';

export type { DeviceFolderNodeContext } from './tree-context';

/** 拖过折叠分组多久自动展开 */
const AUTO_EXPAND_MS = 600;

export interface DeviceFolderTreeHandle {
  /** 在列表末尾插入一行处于编辑态的新建分组（顶栏按钮用） */
  startNewFolder(): void;
}

export interface DeviceFolderTreeProps {
  layout: DeviceFolderLayout;
  /** 没有 placement 的根层节点，按宿主给的顺序追加在显式节点之后 */
  implicitRootNodeIds: readonly string[];
  renderNode: (nodeId: string, ctx: DeviceFolderNodeContext) => ReactNode;
  /** 拖拽预览与无障碍公告用的节点名称 */
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
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  const zone = useDropZone(dropZoneId(ROOT_CONTAINER_ID));
  return (
    <div
      ref={zone.ref}
      {...zone.props}
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
  const sensors = useDeviceTreeSensors();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
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

  const activeDrop = useMemo(
    () =>
      activeId && overId
        ? resolveDrop(activeId, overId, layout, implicitRootNodeIds, containers)
        : null,
    [activeId, overId, layout, implicitRootNodeIds, containers]
  );
  const dropContainerId = dropTargetContainerId(activeDrop);
  // 指针停在所有分组之外的空白：整棵树高亮，示意松手会移到最外层
  const rootDropActive =
    activeId !== null && overId === dropZoneId(ROOT_CONTAINER_ID) && activeDrop !== null;
  // 目标分组还收着的时候不插占位条：内容区没挂载，插了也看不见（等自动展开之后再说）
  const placeholder = useMemo(() => {
    const next = previewPlaceholder(layout, implicitRootNodeIds, activeDrop, containers);
    if (!next) return null;
    const folderId = containerFolderId(next.containerId);
    if (folderId && expanded[folderId] === false) return null;
    return next;
  }, [layout, implicitRootNodeIds, activeDrop, expanded, containers]);

  // 拖过折叠的分组停留一会儿就自动展开，方便往里放
  const autoExpandRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoExpandRef.current) clearTimeout(autoExpandRef.current);
    if (!activeId || !dropContainerId) return;
    const folderId = containerFolderId(dropContainerId);
    if (!folderId || expanded[folderId] !== false) return;
    autoExpandRef.current = setTimeout(() => onExpandedChange(folderId, true), AUTO_EXPAND_MS);
    return () => {
      if (autoExpandRef.current) clearTimeout(autoExpandRef.current);
    };
  }, [activeId, dropContainerId, expanded, onExpandedChange]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragId = String(event.active.id);
      const dropId = event.over ? String(event.over.id) : null;
      setActiveId(null);
      setOverId(null);
      // 指针离开整棵树（含拖出窗口）：取消，不动布局
      if (disabled || dropId === null) return;
      const drop = resolveDrop(dragId, dropId, layout, implicitRootNodeIds, containers);
      if (drop) onDrop(drop);
    },
    [disabled, layout, implicitRootNodeIds, containers, onDrop]
  );

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
        collisionDetection={deviceFolderCollisionDetection}
        // 拖拽过程中条目会挪位置（折叠的分组自动展开、占位条插进插出挤动同行 / 后续各行），
        // 必须持续重新测量
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
        onDragOver={(event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null)}
        onDragCancel={() => {
          setActiveId(null);
          setOverId(null);
        }}
        onDragEnd={handleDragEnd}
      >
        <TreeRoot active={rootDropActive} className={className}>
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
