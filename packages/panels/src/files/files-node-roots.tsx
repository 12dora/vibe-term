// 一个 node 的文件树：根目录列表（含拖拽排序）与递归的目录/文件行。
//
// 组件必须挂在该 node 的运行时（`RuntimeProvider` + 该 node 的 QueryClient）下——
// 查询走 `useRuntime().apiClient`，可见性按 `useRuntime().nodeId` 过滤。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchDevices,
  fetchFileRoots,
  fetchLlmProviders,
  reorderFileRoots,
} from '@tmex/api-client';
import type { FileEntryDto, FileRootDto, SystemInfo } from '@tmex/shared';
import { useFileTreeStore, useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Loader2, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SortableVerticalList, useSortableRow } from '../device-tree/device-tree-dnd';
import { type DirectoryDragHandle, DirectoryNodeView } from './directory-node-view';
import { fileIconColor, fileIconFor } from './file-icon';
import { FileLeafContextMenu } from './file-leaf-menu';
import { NodeError } from './node-menu';
import {
  FILE_ROOTS_QUERY_KEY,
  fileRootOrderToSubmit,
  fileRootReorderOptions,
} from './root-reorder';
import { selectVisibleFileRoots } from './root-visibility';
import { SelectedFileProvider, useIsFileSelected, useSelectedChildPath } from './selected-file';
import { ShowAllEntriesProvider, useShowAllEntries } from './show-all-entries';
import { useDirectoryListing } from './use-directory-listing';
import { useDirectoryUpload } from './use-directory-upload';
import { useRsyncMissingToast } from './use-rsync-missing-toast';

const DEFAULT_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const INDENT_STEP = 12;

// 单个目录一次最多渲染多少行：后端每目录上限 2000，全量挂载会造出上千个 DOM 行
const DISPLAY_CAP = 500;

interface TreeContext {
  llmConfigured: boolean;
  localDeviceId: string | null;
  transferMaxBytes: number;
}

/** 拖拽结束后提交整份顺序；失败回滚并提示，随后统一 invalidate 以服务端顺序收口。 */
function useFileRootReorder(
  allRoots: readonly FileRootDto[],
  visibleIds: readonly string[]
): { onReorder: (nextVisibleIds: string[]) => void; pending: boolean } {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();

  const mutation = useMutation(
    fileRootReorderOptions({
      queryClient,
      submit: (rootIds) => reorderFileRoots(rootIds, apiClient),
      onFailed: () => toast.error(t('files.reorderFailed')),
    })
  );

  const { mutate, isPending } = mutation;
  const onReorder = useCallback(
    (nextVisibleIds: string[]) => {
      const rootIds = fileRootOrderToSubmit(allRoots, visibleIds, nextVisibleIds, isPending);
      if (rootIds) mutate(rootIds);
    },
    [allRoots, visibleIds, isPending, mutate]
  );
  return { onReorder, pending: isPending };
}

/**
 * 当前运行时下「该显示哪些根目录」。
 *
 * 分节头（`FilesNodeSection`）也要据此决定整节渲不渲染，所以抽成 hook：同一个 QueryClient 下
 * 多处调用共用同一份 roots 查询，不会多打一次请求。
 */
export function useVisibleFileRoots() {
  const { apiClient, nodeId } = useRuntime();
  const rootsQuery = useQuery({
    queryKey: FILE_ROOTS_QUERY_KEY,
    queryFn: () => fetchFileRoots(apiClient),
    refetchOnWindowFocus: true,
  });
  const filesVisibility = useUIStore((state) => state.sidebarFilesVisibility);
  const deviceConnected = useTmuxStore((state) => state.deviceConnected);
  const allRoots = useMemo(() => rootsQuery.data?.roots ?? [], [rootsQuery.data]);
  const roots = useMemo(
    () =>
      selectVisibleFileRoots({
        roots: allRoots,
        runtimeNodeId: nodeId,
        visibility: filesVisibility,
        deviceConnected,
      }),
    [allRoots, nodeId, filesVisibility, deviceConnected]
  );
  return { rootsQuery, allRoots, roots };
}

export function FilesNodeRoots() {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const pruneStaleRoots = useFileTreeStore((s) => s.pruneStaleRoots);

  const { rootsQuery, allRoots, roots } = useVisibleFileRoots();
  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(apiClient),
  });
  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => fetchLlmProviders(undefined, apiClient),
    throwOnError: false,
  });
  const systemInfoQuery = useQuery({
    queryKey: ['system', 'info'],
    queryFn: async () => {
      const res = await apiClient.fetch('/api/system/info');
      if (!res.ok) throw new Error('system');
      return (await res.json()) as SystemInfo;
    },
    throwOnError: false,
  });

  const visibleIds = useMemo(() => roots.map((root) => root.id), [roots]);
  const reorder = useFileRootReorder(allRoots, visibleIds);

  // 加载后清理陈旧的持久化展开键（根/设备已不存在）
  useEffect(() => {
    if (rootsQuery.data) pruneStaleRoots(rootsQuery.data.roots.map((r) => r.id));
  }, [rootsQuery.data, pruneStaleRoots]);

  // 每次渲染都新建 ctx 会让整棵树的 memo 失效
  const ctx = useMemo<TreeContext>(
    () => ({
      llmConfigured: (providersQuery.data?.providers ?? []).length > 0,
      localDeviceId: devicesQuery.data?.devices.find((d) => d.type === 'local')?.id ?? null,
      transferMaxBytes: systemInfoQuery.data?.transferMaxBytes ?? DEFAULT_TRANSFER_MAX_BYTES,
    }),
    [providersQuery.data, devicesQuery.data, systemInfoQuery.data]
  );

  return (
    <SelectedFileProvider>
      <ShowAllEntriesProvider>
        {/* space-y-0.5 原本由宿主容器给根行之间加间距；这里多了一层 trigger，间距跟着下移一层 */}
        <FileLeafContextMenu roots={roots} className="space-y-0.5">
          <SortableVerticalList
            ids={visibleIds}
            onReorder={reorder.onReorder}
            disabled={reorder.pending}
          >
            {roots.map((root) => (
              <SortableRootNode key={root.id} root={root} ctx={ctx} />
            ))}
          </SortableVerticalList>
        </FileLeafContextMenu>
      </ShowAllEntriesProvider>
      {rootsQuery.isLoading && (
        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
          {t('common.loading')}
        </div>
      )}
      {/* 加载失败与「没有可访问目录」是两种状态：失败时给重试，不能显示成空态 */}
      {rootsQuery.isError && (
        <div
          data-testid="files-roots-error"
          className="flex flex-col items-center gap-2 px-3 py-6 text-center"
        >
          <span className="flex items-center gap-1.5 text-xs text-destructive/80">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {t('files.error.unknown')}
          </span>
          <Button
            variant="outline"
            size="xs"
            data-testid="files-roots-retry"
            onClick={() => void rootsQuery.refetch()}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {!rootsQuery.isLoading && !rootsQuery.isError && roots.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {t('files.noRoots')}
        </div>
      )}
    </SelectedFileProvider>
  );
}

function SortableRootNode({ root, ctx }: { root: FileRootDto; ctx: TreeContext }) {
  const { t } = useTranslation();
  const sortable = useSortableRow(root.id);
  return (
    <DirNode
      root={root}
      rootId={root.id}
      path={root.path}
      depth={0}
      isRoot
      ctx={ctx}
      drag={{ sortable, label: t('files.rootDragHandle') }}
    />
  );
}

// 递归的目录节点：把数据（列表 + 轮询）、上传、rsync 提示三块副作用交给对应 hooks，
// 自身只负责组合与递归渲染子节点。
const DirNode = memo(function DirNode({
  root,
  rootId,
  path,
  depth,
  isRoot,
  ctx,
  drag,
}: {
  root: FileRootDto;
  rootId: string;
  path: string;
  depth: number;
  isRoot: boolean;
  ctx: TreeContext;
  drag?: DirectoryDragHandle;
}) {
  const { t } = useTranslation();
  const { nodeKey, expanded, toggle, query, entries, errCode } = useDirectoryListing(rootId, path);
  const upload = useDirectoryUpload(rootId, path, ctx.transferMaxBytes);

  useRsyncMissingToast({
    root,
    nodeKey,
    errCode,
    llmConfigured: ctx.llmConfigured,
    localDeviceId: ctx.localDeviceId,
  });

  // 「显示全部」提到根节点之上：拖拽 chunk 落地会重挂整棵树，放在这里会被清零（见 show-all-entries）
  const { showAll, show: onShowAll } = useShowAllEntries(nodeKey);

  const indent = depth * INDENT_STEP + 4;
  const childIndent = indent + 18;
  // 文件行比同级的状态行（加载中/显示其余）多缩进一级，与子目录行对齐
  const leafIndent = childIndent + INDENT_STEP;
  const symlinkTitle = t('files.symlink');
  // 选中的文件落在上限之外时把上限撑到它，否则路由直达的那一行根本不会挂载
  const selectedChild = useSelectedChildPath(rootId, path);
  const cap =
    entries && entries.length > DISPLAY_CAP && selectedChild !== null
      ? Math.max(DISPLAY_CAP, entries.findIndex((entry) => entry.path === selectedChild) + 1)
      : DISPLAY_CAP;
  const hidden = !showAll && entries ? Math.max(entries.length - cap, 0) : 0;
  const visible = hidden > 0 && entries ? entries.slice(0, cap) : entries;

  return (
    <DirectoryNodeView
      root={root}
      rootId={rootId}
      path={path}
      indent={indent}
      isRoot={isRoot}
      expanded={expanded}
      dragActive={upload.dragActive}
      onToggle={toggle}
      dropZoneProps={upload.dropZoneProps}
      fileInputRef={upload.fileInputRef}
      onPickFiles={upload.openFilePicker}
      onFileInputChange={upload.handleFileInputChange}
      drag={drag}
    >
      {/* 这两个属性是共享右键菜单回查 entry 的唯一线索（见 file-leaf-target 的常量）：
          行只留自己的路径，根 id 与所在目录由容器带 */}
      <div data-file-list-root={rootId} data-file-list-dir={path}>
        {(query.isLoading || (query.isFetching && !query.data)) && (
          <div
            style={{ paddingLeft: childIndent }}
            className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('common.loading')}
          </div>
        )}
        {query.isError && (
          <NodeError code={errCode} indent={childIndent} onRetry={() => void query.refetch()} />
        )}
        {visible?.map((entry) =>
          entry.type === 'dir' ? (
            <DirNode
              key={entry.path}
              root={root}
              rootId={rootId}
              path={entry.path}
              depth={depth + 1}
              isRoot={false}
              ctx={ctx}
            />
          ) : (
            <FileLeaf
              key={entry.path}
              entry={entry}
              rootId={rootId}
              indent={leafIndent}
              symlinkTitle={symlinkTitle}
            />
          )
        )}
        {hidden > 0 && (
          <button
            type="button"
            data-testid={`file-show-more-${rootId}-${path}`}
            onClick={onShowAll}
            style={{ paddingLeft: childIndent }}
            className="flex w-full min-w-0 items-center rounded-md py-1 pr-2 text-left text-[11px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            {t('files.showMore', { count: hidden })}
          </button>
        )}
        {query.data && query.data.entries.length === 0 && (
          <div
            style={{ paddingLeft: childIndent }}
            className="py-1 text-[11px] text-muted-foreground/70"
          >
            {t('files.emptyDir')}
          </div>
        )}
        {query.data?.truncated && (
          <div
            style={{ paddingLeft: childIndent }}
            className="py-1 text-[11px] text-muted-foreground/70"
          >
            {t('files.truncated')}
          </div>
        )}
      </div>
    </DirectoryNodeView>
  );
});

// 行只剩一个 `<button>`：没有右键菜单、没有回调、没有 useTranslation——点击/右键/长按/拖拽
// 全部由树根的 `FileLeafContextMenu` 事件委托接管（见 EX1 §U5 的 17 倍单价）。
const FileLeaf = memo(function FileLeaf({
  entry,
  rootId,
  indent,
  symlinkTitle,
}: { entry: FileEntryDto; rootId: string; indent: number; symlinkTitle: string }) {
  const isSelected = useIsFileSelected(rootId, entry.path);
  const Icon = fileIconFor(entry);

  return (
    <button
      type="button"
      draggable
      data-file-leaf-path={entry.path}
      data-testid={`file-item-${rootId}-${entry.path}`}
      title={entry.name}
      style={{ paddingLeft: indent }}
      className={cn(
        'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors data-[pressed]:bg-sidebar-accent [@media(any-pointer:coarse)]:py-1.5',
        isSelected
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-foreground'
      )}
    >
      <Icon
        className={cn(
          'h-4 w-4 shrink-0',
          isSelected ? 'text-primary' : fileIconColor(entry.category)
        )}
      />
      <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
      {entry.isSymlink && (
        <span className="shrink-0 text-[9px] text-muted-foreground/60" title={symlinkTitle}>
          ↗
        </span>
      )}
    </button>
  );
});
