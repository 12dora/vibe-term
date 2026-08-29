// 设备分组列表的通用 UI：只认 `DeviceFolderLayout`、节点 id 与宿主给的 `renderNode`，
// 不知道设备这个业务概念，宿主（apps/fe）负责把节点渲染成分组头 + 卡片网格。
//
// 落点判定全部在 `folder-tree-model.ts`（纯函数，有单测），本文件只做交互与呈现：
// 命中高亮、折叠分组的悬停自动展开、跟手的卡片式拖拽预览、就地重命名 / 新建 / 删除确认，
// 以及拖拽过程中的「腾位置」预览（跨容器移动时目标容器的兄弟当场让开，松手才提交）。
//
// 移到最外层没有按钮也没有落点条：整棵树本身就是一个落点区，把节点拖到所有分组虚线框
// 之外的空白处松手即回到根层；指针离开整棵树（`over` 为空）则视为取消。

import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  closestCenter,
  pointerWithin,
  useDroppable,
} from '@dnd-kit/core';
import type {
  CollisionDetection,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  type DeviceFolder,
  type DeviceFolderLayout,
  countFolderItems,
  findNodeFolderId,
} from '@tmex/shared';
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
import { DeviceFolderNodeShell } from './draggable-item';
import { FolderNameEditor } from './folder-name-editor';
import { FolderDropArea, FolderSection } from './folder-section';
import {
  type DeviceFolderContainer,
  type DeviceFolderDrop,
  ROOT_CONTAINER_ID,
  applyDrop,
  bodyDropZoneId,
  collisionGroupIds,
  containerFolderId,
  dropTargetContainerId,
  dropZoneId,
  folderContainerId,
  listContainers,
  nodeDropIntent,
  parseFolderElementId,
  parseNodeElementId,
  rebaseNodeDrop,
  resolveDrop,
  rootFolderElementIds,
  implicitRootNodeIds as unplacedNodeIds,
} from './folder-tree-model';
import { snapCenterToCursor } from './snap-to-cursor';

/** 拖过折叠分组多久自动展开 */
const AUTO_EXPAND_MS = 600;

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
  /** 拖拽预览生效后的布局（没在拖就是真实布局） */
  layout: DeviceFolderLayout;
  expandedOf: (folderId: string) => boolean;
  dropContainerId: string | null;
  dragDisabled: boolean;
  creatingFolder: boolean;
  renamingFolderId: string | null;
  props: DeviceFolderTreeProps;
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

/**
 * 按 `collisionGroupIds` 的四档依次判定，先命中先返回：
 *   放置区（分组头 / 空分组内容区）→ 兄弟元素 → 分组本体 → 整棵树的根落点区。
 * 分开跑而不是交给一次 `pointerWithin`：这些矩形互相嵌套，混在一起排序会让
 * 「拖到分组头上」时不时落成「插到该分组的第一个节点前面」，也会让分组内的空隙落成根层。
 */
const collisionDetection: CollisionDetection = (args) => {
  const ids = args.droppableContainers.map((container) => String(container.id));
  const groups = collisionGroupIds(String(args.active.id), ids);
  const pick = (allowed: readonly string[]) => {
    const set = new Set(allowed);
    return args.droppableContainers.filter((container) => set.has(String(container.id)));
  };
  // 键盘拖拽没有指针坐标（`pointerWithin` 恒为空）：退回最近中心，且只在「放置区 + 兄弟元素」
  // 里选。分组本体与根落点区的矩形太大，参与最近中心会把每一步都吸成「整个分组 / 最外层」。
  // 键盘要把节点挪出分组，落到任意一个根层兄弟上即可。
  if (!args.pointerCoordinates) {
    return closestCenter({
      ...args,
      droppableContainers: pick([...groups.zones, ...groups.items]),
    });
  }
  for (const tier of [groups.zones, groups.items, groups.containers, groups.root]) {
    const hits = pointerWithin({ ...args, droppableContainers: pick(tier) });
    if (hits.length > 0) return hits;
  }
  return [];
};

function NodeItem({ nodeId, folderId }: { nodeId: string; folderId: string | null }) {
  const { props, dragDisabled, layout } = useTree();
  const implicit = !layout.placements.some((placement) => placement.nodeId === nodeId);
  if (props.nodeDraggable && !props.nodeDraggable(nodeId, { folderId })) {
    const content = props.renderNode(nodeId, {
      folderId,
      implicit,
      dragDisabled,
      dragControls: null,
    });
    if (content === null || content === undefined || content === false) return null;
    return <div data-testid={`device-folder-item-node:${nodeId}`}>{content}</div>;
  }
  return (
    <DeviceFolderNodeShell nodeId={nodeId} disabled={dragDisabled}>
      {(dragControls) =>
        props.renderNode(nodeId, { folderId, implicit, dragDisabled, dragControls })
      }
    </DeviceFolderNodeShell>
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

  return (
    <SortableContext
      items={container.nodeIds}
      strategy={verticalListSortingStrategy}
      disabled={tree.dragDisabled}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {container.nodeIds.map((elementId) => {
          const nodeId = parseNodeElementId(elementId);
          if (!nodeId) return null;
          return <NodeItem key={elementId} nodeId={nodeId} folderId={folderId} />;
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
  const { foldersById, itemCounts, props } = useTree();
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
          <span className="min-w-0 flex-1 truncate font-medium">{props.nodeLabel(nodeId)}</span>
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
  const { setNodeRef } = useDroppable({ id: dropZoneId(ROOT_CONTAINER_ID) });
  return (
    <div
      ref={setNodeRef}
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
  // 拖拽中的「腾位置」预览：跨容器移动当场生效（目标容器的兄弟让开），松手才提交，取消即丢弃
  const [previewDrop, setPreviewDrop] = useState<DeviceFolderDrop | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<DeviceFolder | null>(null);

  const previewLayout = useMemo(() => {
    if (!previewDrop) return layout;
    return applyDrop(layout, previewDrop, implicitRootNodeIds) ?? layout;
  }, [layout, previewDrop, implicitRootNodeIds]);
  // 预览布局可能把隐式根节点落成了显式 placement，隐式列表必须跟着收窄，否则会重复渲染
  const previewImplicit = useMemo(
    () => unplacedNodeIds(previewLayout, implicitRootNodeIds),
    [previewLayout, implicitRootNodeIds]
  );

  const containers = useMemo(
    () => listContainers(previewLayout, previewImplicit),
    [previewLayout, previewImplicit]
  );
  const folderElementIds = useMemo(() => rootFolderElementIds(previewLayout), [previewLayout]);
  const foldersById = useMemo(
    () => new Map(previewLayout.folders.map((folder) => [folder.id, folder])),
    [previewLayout.folders]
  );
  const itemCounts = useMemo(() => countFolderItems(previewLayout), [previewLayout]);

  const expandedOf = useCallback((folderId: string) => expanded[folderId] !== false, [expanded]);

  useImperativeHandle(ref, () => ({ startNewFolder: () => setCreatingFolder(true) }), []);

  const activeDrop = useMemo(
    () =>
      activeId && overId ? resolveDrop(activeId, overId, previewLayout, previewImplicit) : null,
    [activeId, overId, previewLayout, previewImplicit]
  );
  const dropContainerId = dropTargetContainerId(activeDrop);
  // 指针停在所有分组之外的空白：整棵树高亮，示意松手会移到最外层
  const rootDropActive =
    activeId !== null && overId === dropZoneId(ROOT_CONTAINER_ID) && activeDrop !== null;

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

  const activeNodeId = activeId === null ? null : parseNodeElementId(activeId);
  const activeContainerId =
    activeNodeId === null ? null : folderContainerId(findNodeFolderId(previewLayout, activeNodeId));

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const nextOverId = event.over ? String(event.over.id) : null;
      setOverId(nextOverId);
      if (disabled || nextOverId === null) return;
      const dragId = String(event.active.id);
      if (parseNodeElementId(dragId) === null) return;
      const drop = resolveDrop(dragId, nextOverId, previewLayout, previewImplicit);
      if (!drop || drop.kind !== 'node') return;
      // 同容器内的重排交给 sortable 自己的 transform；反复改预览会和 dnd-kit 的测量互相触发抖动
      if (folderContainerId(drop.targetFolderId) === activeContainerId) return;
      // 目标分组是收起的：搬进去会连同内容区一起卸载，拖拽会当场断掉。等自动展开之后再说
      if (drop.targetFolderId !== null && expanded[drop.targetFolderId] === false) return;
      const intent = rebaseNodeDrop(previewLayout, previewImplicit, drop);
      if (intent) setPreviewDrop(intent);
    },
    [disabled, previewLayout, previewImplicit, activeContainerId, expanded]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dragId = String(event.active.id);
      const dropId = event.over ? String(event.over.id) : null;
      setActiveId(null);
      setOverId(null);
      setPreviewDrop(null);
      // 指针离开整棵树（含拖出窗口）：取消，不动布局
      if (disabled || dropId === null) return;
      const nodeId = parseNodeElementId(dragId);
      if (nodeId === null) {
        const drop = resolveDrop(dragId, dropId, layout, implicitRootNodeIds);
        if (drop) onDrop(drop);
        return;
      }
      // 提交的是「预览里摆好的样子」：先把落点应用到预览布局，再把节点最终的容器 + 下标
      // 翻译回一次针对真实布局的移动，避免预览与提交差一位。
      const settled = resolveDrop(dragId, dropId, previewLayout, previewImplicit);
      const drop = settled
        ? rebaseNodeDrop(previewLayout, previewImplicit, settled)
        : nodeDropIntent(previewLayout, previewImplicit, nodeId);
      if (!drop) return;
      // 拖回原处：不必白发一次整表替换
      const before = nodeDropIntent(layout, implicitRootNodeIds, nodeId);
      if (before && before.targetFolderId === drop.targetFolderId && before.index === drop.index) {
        return;
      }
      onDrop(drop);
    },
    [disabled, layout, implicitRootNodeIds, previewLayout, previewImplicit, onDrop]
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
      layout: previewLayout,
      expandedOf,
      dropContainerId,
      dragDisabled: disabled,
      creatingFolder,
      renamingFolderId,
      props,
      actions,
    }),
    [
      containers,
      foldersById,
      itemCounts,
      previewLayout,
      expandedOf,
      dropContainerId,
      disabled,
      creatingFolder,
      renamingFolderId,
      props,
      actions,
    ]
  );

  return (
    <TreeContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        // 拖拽过程中容器高度会变（折叠的分组自动展开、预览把节点搬进搬出），必须持续重新测量
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(event: DragStartEvent) => {
          setActiveId(String(event.active.id));
          setPreviewDrop(null);
        }}
        onDragOver={handleDragOver}
        onDragCancel={() => {
          setActiveId(null);
          setOverId(null);
          setPreviewDrop(null);
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
