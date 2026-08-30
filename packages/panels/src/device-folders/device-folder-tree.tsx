// 设备分组列表的通用 UI：只认 `DeviceFolderLayout`、节点 id 与宿主给的 `renderNode`，
// 不知道设备这个业务概念，宿主（apps/fe）负责把节点渲染成分组头 + 卡片网格。
//
// 落点判定全部在 `folder-tree-model.ts` / `collision.ts`（纯函数，有单测），本文件只做交互与
// 呈现：命中高亮、折叠分组的悬停自动展开、跟手的卡片式拖拽预览、就地重命名 / 新建 / 删除确认，
// 以及拖拽过程中的「腾位置」预览——跨容器时被拖的节点**留在原容器**（变暗），目标容器里插一条
// 等高的占位条把兄弟顶开，松手才真的提交。
//
// 移到最外层没有按钮也没有落点条：整棵树本身就是一个落点区，把节点拖到所有分组虚线框
// 之外的空白处松手即回到根层；指针离开整棵树（`over` 为空）则视为取消。

import { DndContext, DragOverlay, MeasuringStrategy, useDndContext } from '@dnd-kit/core';
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { type DeviceFolder, type DeviceFolderLayout, countFolderItems } from '@tmex/shared';
import { cn } from '@tmex/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Folder, Server, Trash2 } from 'lucide-react';
import {
  type ReactNode,
  type Ref,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceTreeSensors } from '../device-tree/device-tree-dnd';
import { deviceFolderCollisionDetection } from './collision';
import { DeviceFolderNodeShell } from './draggable-item';
import { useDropZone } from './drop-zone';
import { FolderNameEditor } from './folder-name-editor';
import { FolderDropArea, FolderSection } from './folder-section';
import {
  type DeviceFolderContainer,
  type DeviceFolderDrop,
  type DeviceFolderPlaceholder,
  PLACEHOLDER_ITEM_ID,
  ROOT_CONTAINER_ID,
  bodyDropZoneId,
  containerFolderId,
  containerItemIds,
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
import { snapCenterToCursor } from './snap-to-cursor';

/** 拖过折叠分组多久自动展开 */
const AUTO_EXPAND_MS = 600;

/** 量不到被拖节点高度时占位条的兜底高度 */
const PLACEHOLDER_MIN_HEIGHT = 48;

export interface DeviceFolderNodeContext {
  /** 节点所在分组；null = 根层 */
  folderId: string | null;
  /** 该节点没有 placement（还挂在根层的默认位置上） */
  implicit: boolean;
  /** 上一次布局提交还在飞，拖拽应当禁用 */
  dragDisabled: boolean;
  /** 拖拽把手；宿主放进节点头部。不可拖时为 null */
  dragControls: ReactNode | null;
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
  /** 拖拽预览与无障碍公告用的节点名称 */
  nodeLabel: (nodeId: string) => string;
  /** 返回 false 的节点不套拖拽外壳（该节点本来就不该被拖，如 standalone 下唯一的本机） */
  nodeDraggable?: (nodeId: string, ctx: { folderId: string | null }) => boolean;
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

interface TreeContextValue {
  containers: Map<string, DeviceFolderContainer>;
  foldersById: Map<string, DeviceFolder>;
  itemCounts: Map<string, number>;
  layout: DeviceFolderLayout;
  expandedOf: (folderId: string) => boolean;
  dropContainerId: string | null;
  /** 跨容器拖拽时占位条插在哪；同容器重排为 null */
  placeholder: DeviceFolderPlaceholder | null;
  dragDisabled: boolean;
  creatingFolder: boolean;
  renamingFolderId: string | null;
  renderNode: DeviceFolderTreeProps['renderNode'];
  nodeDraggable: DeviceFolderTreeProps['nodeDraggable'];
  nodeLabel: DeviceFolderTreeProps['nodeLabel'];
  actions: {
    toggle: (folderId: string, expanded: boolean) => void;
    startRename: (folderId: string) => void;
    submitRename: (folderId: string, name: string) => void;
    cancelRename: () => void;
    submitNewFolder: (name: string) => void;
    cancelNewFolder: () => void;
    requestDelete: (folder: DeviceFolder) => void;
  };
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTree(): TreeContextValue {
  const value = useContext(TreeContext);
  if (!value) throw new Error('DeviceFolderTree 的子组件必须渲染在 DeviceFolderTree 内');
  return value;
}

function NodeItem({
  nodeId,
  containerId,
  folderId,
}: {
  nodeId: string;
  containerId: string;
  folderId: string | null;
}) {
  const { renderNode, nodeDraggable, dragDisabled, layout } = useTree();
  const implicit = !layout.placements.some((placement) => placement.nodeId === nodeId);
  if (nodeDraggable && !nodeDraggable(nodeId, { folderId })) {
    const content = renderNode(nodeId, { folderId, implicit, dragDisabled, dragControls: null });
    if (content === null || content === undefined || content === false) return null;
    return <div data-testid={`device-folder-item-node:${nodeId}`}>{content}</div>;
  }
  return (
    <DeviceFolderNodeShell nodeId={nodeId} containerId={containerId} disabled={dragDisabled}>
      {(dragControls) => renderNode(nodeId, { folderId, implicit, dragDisabled, dragControls })}
    </DeviceFolderNodeShell>
  );
}

/**
 * 跨容器拖拽时插进目标容器的占位条：只占一格高度，把后面的兄弟顶下去。
 * 它不是 droppable，不参与落点判定；被拖的节点自始至终留在原容器里（只是变暗），
 * 免得它的 React 子树（宿主的 runtime scope / QueryClientProvider / 面板）在拖拽途中重挂。
 */
function DropPlaceholder() {
  const { activeNodeRect } = useDndContext();
  const height = Math.max(activeNodeRect?.height ?? 0, PLACEHOLDER_MIN_HEIGHT);
  return (
    <div
      aria-hidden="true"
      data-testid="device-folder-drop-placeholder"
      className="rounded-xl border-2 border-dashed border-ring/50 bg-accent/30"
      style={{ height }}
    />
  );
}

function NodeList({ containerId }: { containerId: string }) {
  const { t } = useTranslation();
  const tree = useTree();
  const container = tree.containers.get(containerId);
  const folderId = containerFolderId(containerId) ?? null;
  if (!container) return null;

  if (container.nodeIds.length === 0) {
    if (folderId === null) return null;
    return (
      <FolderDropArea
        zoneId={bodyDropZoneId(containerId)}
        testId={`device-folder-drop-${folderId}`}
        active={tree.dropContainerId === containerId}
        label={t('devices.folders.empty')}
        activeLabel={t('devices.folders.dropHere', {
          name: tree.foldersById.get(folderId)?.name ?? '',
        })}
      />
    );
  }

  const items = containerItemIds(containerId, container.nodeIds, tree.placeholder);

  return (
    <SortableContext
      items={container.nodeIds}
      strategy={verticalListSortingStrategy}
      disabled={tree.dragDisabled}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {items.map((elementId) => {
          if (elementId === PLACEHOLDER_ITEM_ID) return <DropPlaceholder key={elementId} />;
          const nodeId = parseNodeElementId(elementId);
          if (!nodeId) return null;
          return (
            <NodeItem
              key={elementId}
              nodeId={nodeId}
              containerId={containerId}
              folderId={folderId}
            />
          );
        })}
      </div>
    </SortableContext>
  );
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
        'flex min-w-0 flex-col gap-3 rounded-xl transition-[box-shadow] duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
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
  const { t } = useTranslation();
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
  const folderElementIds = useMemo(() => rootFolderElementIds(layout), [layout]);
  const foldersById = useMemo(
    () => new Map(layout.folders.map((folder) => [folder.id, folder])),
    [layout.folders]
  );
  const itemCounts = useMemo(() => countFolderItems(layout), [layout]);

  const expandedOf = useCallback((folderId: string) => expanded[folderId] !== false, [expanded]);

  useImperativeHandle(ref, () => ({ startNewFolder: () => setCreatingFolder(true) }), []);

  const activeDrop = useMemo(
    () => (activeId && overId ? resolveDrop(activeId, overId, layout, implicitRootNodeIds) : null),
    [activeId, overId, layout, implicitRootNodeIds]
  );
  const dropContainerId = dropTargetContainerId(activeDrop);
  // 指针停在所有分组之外的空白：整棵树高亮，示意松手会移到最外层
  const rootDropActive =
    activeId !== null && overId === dropZoneId(ROOT_CONTAINER_ID) && activeDrop !== null;
  // 目标分组还收着的时候不插占位条：内容区没挂载，插了也看不见（等自动展开之后再说）
  const placeholder = useMemo(() => {
    const next = previewPlaceholder(layout, implicitRootNodeIds, activeDrop);
    if (!next) return null;
    const folderId = containerFolderId(next.containerId);
    if (folderId && expanded[folderId] === false) return null;
    return next;
  }, [layout, implicitRootNodeIds, activeDrop, expanded]);

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
      const drop = resolveDrop(dragId, dropId, layout, implicitRootNodeIds);
      if (drop) onDrop(drop);
    },
    [disabled, layout, implicitRootNodeIds, onDrop]
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
      layout,
      expandedOf,
      dropContainerId,
      placeholder,
      dragDisabled: disabled,
      creatingFolder,
      renamingFolderId,
      renderNode,
      nodeDraggable,
      nodeLabel,
      actions,
    }),
    [
      containers,
      foldersById,
      itemCounts,
      layout,
      expandedOf,
      dropContainerId,
      placeholder,
      disabled,
      creatingFolder,
      renamingFolderId,
      renderNode,
      nodeDraggable,
      nodeLabel,
      actions,
    ]
  );

  return (
    <TreeContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={deviceFolderCollisionDetection}
        // 拖拽过程中容器高度会变（折叠的分组自动展开、占位条插进插出），必须持续重新测量
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

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => !open && setDeleteCandidate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('devices.folders.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('devices.folders.deleteConfirmDescription', {
                name: deleteCandidate?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="device-folder-delete-confirm"
              onClick={() => {
                if (deleteCandidate) onDeleteFolder(deleteCandidate.id);
                setDeleteCandidate(null);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TreeContext.Provider>
  );
}
