// 设备文件夹树的通用 UI：只认 `DeviceFolderLayout`、条目 key 与宿主给的 `renderItem`，
// 不知道设备 / 节点这些业务概念，宿主（apps/fe）负责把条目渲染成节点分组或设备卡片。
//
// 落点判定全部在 `folder-tree-model.ts`（纯函数，有单测），本文件只做交互与呈现：
// 命中高亮、折叠文件夹的悬停自动展开、拖拽预览、就地重命名 / 新建 / 删除确认。

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
  type DeviceFolderItemRef,
  type DeviceFolderLayout,
  buildDeviceFolderTree,
  deviceFolderItemKey,
  parseDeviceFolderItemKey,
  wouldCreateFolderCycle,
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
import { Folder, Monitor, Trash2 } from 'lucide-react';
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
import { toast } from 'sonner';
import { useDeviceTreeSensors } from '../device-tree/device-tree-dnd';
import { DeviceFolderItemShell } from './draggable-item';
import { FolderNameEditor } from './folder-name-editor';
import { FolderDropArea, FolderSection } from './folder-section';
import {
  type DeviceFolderContainer,
  type DeviceFolderDrop,
  ROOT_CONTAINER_ID,
  bodyDropZoneId,
  containerFolderId,
  dropZoneId,
  folderContainerId,
  listContainers,
  parseDropZoneId,
  parseFolderElementId,
  resolveDrop,
  resolveDropTarget,
} from './folder-tree-model';

/** 拖过折叠文件夹多久自动展开 */
const AUTO_EXPAND_MS = 600;

export interface DeviceFolderItemContext {
  /** 条目所在文件夹；null = 根层 */
  folderId: string | null;
  depth: number;
  /** 该条目没有 placement（还挂在节点分组的默认位置上） */
  implicit: boolean;
  /** 上一次布局提交还在飞，拖拽应当禁用 */
  dragDisabled: boolean;
}

export interface DeviceFolderTreeHandle {
  /** 在某个容器末尾插入一行处于编辑态的新建文件夹（顶栏按钮用） */
  startNewFolder(parentId?: string | null): void;
}

export interface DeviceFolderTreeProps {
  layout: DeviceFolderLayout;
  /** 没有 placement 的根层条目，按宿主给的顺序追加在显式条目之后 */
  implicitRootItems: readonly DeviceFolderItemRef[];
  renderItem: (item: DeviceFolderItemRef, ctx: DeviceFolderItemContext) => ReactNode;
  /** 拖拽预览与无障碍公告用的条目名称 */
  itemLabel: (item: DeviceFolderItemRef) => string;
  /** 返回 false 的条目不套拖拽外壳（宿主自己挂把手，或该条目本来就不该被拖） */
  itemDraggable?: (item: DeviceFolderItemRef, ctx: DeviceFolderItemContext) => boolean;
  /** 文件夹展开态；缺键视为展开 */
  expanded: Record<string, boolean>;
  onExpandedChange: (folderId: string, expanded: boolean) => void;
  onDrop: (drop: DeviceFolderDrop) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onMoveItemToRoot: (item: DeviceFolderItemRef) => void;
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
  dropTargetContainerId: string | null;
  dragDisabled: boolean;
  newFolderParentId: string | null | undefined;
  renamingFolderId: string | null;
  props: DeviceFolderTreeProps;
  actions: {
    toggle: (folderId: string, expanded: boolean) => void;
    startRename: (folderId: string) => void;
    submitRename: (folderId: string, name: string) => void;
    cancelRename: () => void;
    startNewFolder: (parentId: string | null) => void;
    submitNewFolder: (parentId: string | null, name: string) => void;
    cancelNewFolder: () => void;
    moveFolderToParent: (folder: DeviceFolder) => void;
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
 * 先用 pointerWithin 命中放置区（文件夹头 / 空态 / 根层落点条），没命中再按最近中心找兄弟元素。
 * 两步分开跑而不是交给一次 pointerWithin：放置区与它内部的兄弟元素矩形重叠，
 * 混在一起排序会让「拖到文件夹头上」时不时落成「插到该文件夹的第一个孩子前面」。
 */
const collisionDetection: CollisionDetection = (args) => {
  const zones = args.droppableContainers.filter(
    (container) => parseDropZoneId(String(container.id)) !== null
  );
  const zoneHits = pointerWithin({ ...args, droppableContainers: zones });
  if (zoneHits.length > 0) return zoneHits;
  const rest = args.droppableContainers.filter(
    (container) => parseDropZoneId(String(container.id)) === null
  );
  return closestCenter({ ...args, droppableContainers: rest });
};

function ItemNode({ itemKey, ctx }: { itemKey: string; ctx: DeviceFolderItemContext }) {
  const { props, dragDisabled } = useTree();
  const item = parseDeviceFolderItemKey(itemKey);
  if (!item) return null;
  const content = props.renderItem(item, ctx);
  if (content === null || content === undefined || content === false) return null;
  if (props.itemDraggable && !props.itemDraggable(item, ctx)) {
    return <div data-testid={`device-folder-item-${itemKey}`}>{content}</div>;
  }
  return (
    <DeviceFolderItemShell
      itemKey={itemKey}
      disabled={dragDisabled}
      onMoveToRoot={
        ctx.folderId === null || dragDisabled ? undefined : () => props.onMoveItemToRoot(item)
      }
    >
      {content}
    </DeviceFolderItemShell>
  );
}

function ContainerBody({ containerId, depth }: { containerId: string; depth: number }) {
  const { t } = useTranslation();
  const tree = useTree();
  const { containers, foldersById, newFolderParentId, actions, props } = tree;
  const container = containers.get(containerId);
  const folderId = containerFolderId(containerId) ?? null;
  if (!container) return null;

  const editingHere = newFolderParentId !== undefined && newFolderParentId === folderId;
  const empty = container.folderIds.length === 0 && container.itemKeys.length === 0;

  return (
    <>
      {container.folderIds.length > 0 && (
        <SortableContext
          items={container.folderIds}
          strategy={verticalListSortingStrategy}
          disabled={tree.dragDisabled}
        >
          <div className="flex min-w-0 flex-col gap-1">
            {container.folderIds.map((elementId) => {
              const childId = parseFolderElementId(elementId);
              const folder = childId ? foldersById.get(childId) : undefined;
              if (!folder) return null;
              return <FolderNode key={elementId} folder={folder} depth={depth} />;
            })}
          </div>
        </SortableContext>
      )}

      {editingHere && (
        <FolderNameEditor
          testId="device-folder-new"
          className="min-w-0"
          onSubmit={(name) => actions.submitNewFolder(folderId, name)}
          onCancel={actions.cancelNewFolder}
        />
      )}

      {container.itemKeys.length > 0 && (
        <SortableContext
          items={container.itemKeys}
          strategy={verticalListSortingStrategy}
          disabled={tree.dragDisabled}
        >
          <div className="flex min-w-0 flex-col gap-3">
            {container.itemKeys.map((itemKey) => (
              <ItemNode
                key={itemKey}
                itemKey={itemKey}
                ctx={{
                  folderId,
                  depth,
                  implicit: !props.layout.placements.some(
                    (placement) => deviceFolderItemKey(placement) === itemKey
                  ),
                  dragDisabled: tree.dragDisabled,
                }}
              />
            ))}
          </div>
        </SortableContext>
      )}

      {folderId !== null && empty && !editingHere && (
        <FolderDropArea
          zoneId={bodyDropZoneId(containerId)}
          testId={`device-folder-drop-${folderId}`}
          active={tree.dropTargetContainerId === containerId}
          label={t('devices.folders.empty')}
          activeLabel={t('devices.folders.dropHere', {
            name: foldersById.get(folderId)?.name ?? '',
          })}
        />
      )}
    </>
  );
}

function FolderNode({ folder, depth }: { folder: DeviceFolder; depth: number }) {
  const tree = useTree();
  const { actions, expandedOf, itemCounts, dropTargetContainerId } = tree;
  const containerId = folderContainerId(folder.id);
  const expanded = expandedOf(folder.id);

  return (
    <FolderSection
      folder={folder}
      depth={depth}
      itemCount={itemCounts.get(folder.id) ?? 0}
      expanded={expanded}
      renaming={tree.renamingFolderId === folder.id}
      dragDisabled={tree.dragDisabled}
      dropTarget={dropTargetContainerId === containerId}
      onToggle={(next) => actions.toggle(folder.id, next)}
      onStartRename={() => actions.startRename(folder.id)}
      onSubmitRename={(name) => actions.submitRename(folder.id, name)}
      onCancelRename={actions.cancelRename}
      onNewSubfolder={() => actions.startNewFolder(folder.id)}
      onMoveToParent={
        folder.parentId === null || tree.dragDisabled
          ? undefined
          : () => actions.moveFolderToParent(folder)
      }
      onDelete={() => actions.requestDelete(folder)}
    >
      <ContainerBody containerId={containerId} depth={depth + 1} />
    </FolderSection>
  );
}

function DragPreview({ activeId }: { activeId: string }) {
  const { t } = useTranslation();
  const { foldersById, itemCounts, props } = useTree();
  const folderId = parseFolderElementId(activeId);
  const folder = folderId ? foldersById.get(folderId) : undefined;
  const item = folderId === null ? parseDeviceFolderItemKey(activeId) : null;

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
      ) : item ? (
        <>
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{props.itemLabel(item)}</span>
        </>
      ) : null}
    </div>
  );
}

export function DeviceFolderTree(props: DeviceFolderTreeProps) {
  const {
    layout,
    implicitRootItems,
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
  // undefined = 没有在新建；null = 在根层新建
  const [newFolderParentId, setNewFolderParentId] = useState<string | null | undefined>(undefined);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<DeviceFolder | null>(null);

  const containers = useMemo(
    () => listContainers(layout, implicitRootItems),
    [layout, implicitRootItems]
  );
  const foldersById = useMemo(
    () => new Map(layout.folders.map((folder) => [folder.id, folder])),
    [layout.folders]
  );
  const itemCounts = useMemo(() => {
    const tree = buildDeviceFolderTree(layout);
    return new Map([...tree.byId].map(([id, node]) => [id, node.itemCount]));
  }, [layout]);

  const expandedOf = useCallback((folderId: string) => expanded[folderId] !== false, [expanded]);

  const startNewFolder = useCallback(
    (parentId: string | null) => {
      setNewFolderParentId(parentId);
      if (parentId !== null) onExpandedChange(parentId, true);
    },
    [onExpandedChange]
  );

  useImperativeHandle(
    ref,
    () => ({ startNewFolder: (parentId = null) => startNewFolder(parentId) }),
    [startNewFolder]
  );

  const dropTargetContainerId = useMemo(() => {
    if (!activeId || !overId) return null;
    const target = resolveDropTarget(activeId, overId, layout, implicitRootItems);
    if (!target) return null;
    return folderContainerId(target.targetFolderId);
  }, [activeId, overId, layout, implicitRootItems]);

  // 拖过折叠的文件夹停留一会儿就自动展开，方便往深层里放
  const autoExpandRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoExpandRef.current) clearTimeout(autoExpandRef.current);
    if (!activeId || !dropTargetContainerId) return;
    const folderId = containerFolderId(dropTargetContainerId);
    if (!folderId || expanded[folderId] !== false) return;
    autoExpandRef.current = setTimeout(() => onExpandedChange(folderId, true), AUTO_EXPAND_MS);
    return () => {
      if (autoExpandRef.current) clearTimeout(autoExpandRef.current);
    };
  }, [activeId, dropTargetContainerId, expanded, onExpandedChange]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      setOverId(null);
      if (disabled || !event.over) return;
      const active = String(event.active.id);
      const over = String(event.over.id);
      const drop = resolveDrop(active, over, layout, implicitRootItems);
      if (drop) {
        onDrop(drop);
        return;
      }
      // 唯一需要解释的失败：文件夹被放进了自己或自己的后代
      const folderId = parseFolderElementId(active);
      const target = folderId ? resolveDropTarget(active, over, layout, implicitRootItems) : null;
      if (
        folderId &&
        target &&
        wouldCreateFolderCycle(layout.folders, folderId, target.targetFolderId)
      ) {
        toast.error(t('devices.folders.cycle'));
      }
    },
    [disabled, layout, implicitRootItems, onDrop, t]
  );

  const actions = useMemo<TreeContextValue['actions']>(
    () => ({
      toggle: (folderId, next) => onExpandedChange(folderId, next),
      startRename: (folderId) => {
        setNewFolderParentId(undefined);
        setRenamingFolderId(folderId);
      },
      submitRename: (folderId, name) => {
        setRenamingFolderId(null);
        const current = foldersById.get(folderId);
        if (current && current.name === name) return;
        onRenameFolder(folderId, name);
      },
      cancelRename: () => setRenamingFolderId(null),
      startNewFolder,
      submitNewFolder: (parentId, name) => {
        setNewFolderParentId(undefined);
        onCreateFolder(name, parentId);
      },
      cancelNewFolder: () => setNewFolderParentId(undefined),
      moveFolderToParent: (folder) => {
        const parent = folder.parentId === null ? null : foldersById.get(folder.parentId);
        onDrop({
          kind: 'folder',
          folderId: folder.id,
          targetFolderId: parent?.parentId ?? null,
          index: null,
        });
      },
      requestDelete: (folder) => setDeleteCandidate(folder),
    }),
    [foldersById, onCreateFolder, onDrop, onExpandedChange, onRenameFolder, startNewFolder]
  );

  const contextValue = useMemo<TreeContextValue>(
    () => ({
      containers,
      foldersById,
      itemCounts,
      expandedOf,
      dropTargetContainerId,
      dragDisabled: disabled,
      newFolderParentId,
      renamingFolderId,
      props,
      actions,
    }),
    [
      containers,
      foldersById,
      itemCounts,
      expandedOf,
      dropTargetContainerId,
      disabled,
      newFolderParentId,
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
        // 拖拽过程中容器高度会变（折叠的文件夹自动展开、根层落点条出现），必须持续重新测量
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
          <ContainerBody containerId={ROOT_CONTAINER_ID} depth={0} />
          {activeId !== null && (
            <FolderDropArea
              zoneId={dropZoneId(ROOT_CONTAINER_ID)}
              testId="device-folder-drop-root"
              active={dropTargetContainerId === ROOT_CONTAINER_ID}
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
