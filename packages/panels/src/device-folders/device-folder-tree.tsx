// 设备分组列表的通用 UI：只认 `DeviceFolderLayout`、节点 id 与宿主给的 `renderNode`，
// 不知道设备这个业务概念，宿主（apps/fe）负责把节点渲染成分组头 + 卡片网格。
//
// 落点判定全部在 `folder-tree-model.ts`（纯函数，有单测），本文件只做交互与呈现：
// 命中高亮、折叠分组的悬停自动展开、拖拽预览、就地重命名 / 新建 / 删除确认、
// 以及拖动分组内节点时出现在列表末尾的「移到最外层」落点条。

import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  closestCenter,
  pointerWithin,
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
  bodyDropZoneId,
  collisionCandidateIds,
  containerFolderId,
  dropTargetContainerId,
  dropZoneId,
  folderContainerId,
  listContainers,
  parseDropZoneId,
  parseFolderElementId,
  parseNodeElementId,
  resolveDrop,
  rootFolderElementIds,
} from './folder-tree-model';

/** 拖过折叠分组多久自动展开 */
const AUTO_EXPAND_MS = 600;

export interface DeviceFolderNodeContext {
  /** 节点所在分组；null = 根层 */
  folderId: string | null;
  /** 该节点没有 placement（还挂在根层的默认位置上） */
  implicit: boolean;
  /** 上一次布局提交还在飞，拖拽应当禁用 */
  dragDisabled: boolean;
  /** 拖拽把手（分组内的节点还带「移出分组」按钮）；宿主放进节点头部。不可拖时为 null */
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
  onMoveNodeToRoot: (nodeId: string) => void;
  /** 上一次布局提交还在飞：禁用拖拽，避免先发后到的旧顺序覆盖新顺序 */
  disabled?: boolean;
  className?: string;
  ref?: Ref<DeviceFolderTreeHandle>;
}

interface TreeContextValue {
  containers: Map<string, DeviceFolderContainer>;
  foldersById: Map<string, DeviceFolder>;
  itemCounts: Map<string, number>;
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
 * 先用 pointerWithin 命中放置区（分组头 / 空态 / 根层落点条），没命中再按最近中心找兄弟元素。
 * 两步分开跑而不是交给一次 pointerWithin：放置区与它内部的兄弟元素矩形重叠，
 * 混在一起排序会让「拖到分组头上」时不时落成「插到该分组的第一个节点前面」。
 */
const collisionDetection: CollisionDetection = (args) => {
  const allowed = new Set(
    collisionCandidateIds(
      String(args.active.id),
      args.droppableContainers.map((container) => String(container.id))
    )
  );
  const candidates = args.droppableContainers.filter((container) =>
    allowed.has(String(container.id))
  );
  const zones = candidates.filter((container) => parseDropZoneId(String(container.id)) !== null);
  const zoneHits = pointerWithin({ ...args, droppableContainers: zones });
  if (zoneHits.length > 0) return zoneHits;
  const rest = candidates.filter((container) => parseDropZoneId(String(container.id)) === null);
  return closestCenter({ ...args, droppableContainers: rest });
};

function NodeItem({ nodeId, folderId }: { nodeId: string; folderId: string | null }) {
  const { props, dragDisabled } = useTree();
  const implicit = !props.layout.placements.some((placement) => placement.nodeId === nodeId);
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
    <DeviceFolderNodeShell
      nodeId={nodeId}
      disabled={dragDisabled}
      onMoveToRoot={
        folderId === null || dragDisabled ? undefined : () => props.onMoveNodeToRoot(nodeId)
      }
    >
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

function DragPreview({ activeId }: { activeId: string }) {
  const { t } = useTranslation();
  const { foldersById, itemCounts, props } = useTree();
  const folderId = parseFolderElementId(activeId);
  const folder = folderId ? foldersById.get(folderId) : undefined;
  const nodeId = folderId === null ? parseNodeElementId(activeId) : null;

  return (
    <div className="flex max-w-xs items-center gap-1.5 rounded-lg border border-border bg-popover px-2 py-1.5 text-sm shadow-lg scale-[1.02] motion-reduce:scale-100">
      {folder ? (
        <>
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">{folder.name}</span>
          <span className="shrink-0 rounded border border-border/60 px-1.5 py-px text-[10px] leading-none text-muted-foreground">
            {t('devices.folders.itemCount', { count: itemCounts.get(folder.id) ?? 0 })}
          </span>
        </>
      ) : nodeId ? (
        <>
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{props.nodeLabel(nodeId)}</span>
        </>
      ) : null}
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

  // 「移到最外层」落点条只在拖动分组里的节点时出现
  const activeNodeId = activeId === null ? null : parseNodeElementId(activeId);
  const showRootDropArea = activeNodeId !== null && findNodeFolderId(layout, activeNodeId) !== null;

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
      setActiveId(null);
      setOverId(null);
      if (disabled || !event.over) return;
      const drop = resolveDrop(
        String(event.active.id),
        String(event.over.id),
        layout,
        implicitRootNodeIds
      );
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
        // 拖拽过程中容器高度会变（折叠的分组自动展开、根层落点条出现），必须持续重新测量
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
        onDragOver={(event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null)}
        onDragCancel={() => {
          setActiveId(null);
          setOverId(null);
        }}
        onDragEnd={handleDragEnd}
      >
        <div
          data-testid="device-folder-tree"
          className={cn('flex min-w-0 flex-col gap-3', className)}
        >
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

          {showRootDropArea && (
            <FolderDropArea
              zoneId={dropZoneId(ROOT_CONTAINER_ID)}
              testId="device-folder-drop-root"
              active={dropContainerId === ROOT_CONTAINER_ID}
              label={t('devices.folders.dropToRoot')}
            />
          )}
        </div>
        <DragOverlay dropAnimation={null}>
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
