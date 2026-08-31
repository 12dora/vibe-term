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
import { decodeFileRef, fileRoute, hostAppPath } from '@tmex/stores';
import { useFileTreeStore, useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@tmex/ui/context-menu';
import { useSidebar } from '@tmex/ui/sidebar';
import { Loader2, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { SortableVerticalList, useSortableRow } from '../device-tree/device-tree-dnd';
import { type DirectoryDragHandle, DirectoryNodeView } from './directory-node-view';
import { fileIconColor, fileIconFor } from './file-icon';
import { FileNodeMenuContent, useFileNodeActions } from './file-node-actions';
import { NodeError } from './node-menu';
import {
  FILE_ROOTS_QUERY_KEY,
  fileRootOrderToSubmit,
  fileRootReorderOptions,
} from './root-reorder';
import { selectVisibleFileRoots } from './root-visibility';
import { useDirectoryListing } from './use-directory-listing';
import { useDirectoryUpload } from './use-directory-upload';
import { useRsyncMissingToast } from './use-rsync-missing-toast';

const DEFAULT_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const INDENT_STEP = 12;

// 单个目录一次最多渲染多少行：后端每目录上限 2000，全量挂载会造出上千个带右键菜单的组件
const DISPLAY_CAP = 500;

function useSelectedFilePath(): { rootId: string; path: string } | null {
  const location = useLocation();
  const { host } = useRuntime();
  return useMemo(() => {
    const match = matchPath(hostAppPath(host, '/file/:ref'), location.pathname);
    if (!match?.params.ref) return null;
    return decodeFileRef(match.params.ref);
  }, [location.pathname, host]);
}

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

export function FilesNodeRoots() {
  const { t } = useTranslation();
  const { apiClient, nodeId } = useRuntime();
  const pruneStaleRoots = useFileTreeStore((s) => s.pruneStaleRoots);

  const rootsQuery = useQuery({
    queryKey: FILE_ROOTS_QUERY_KEY,
    queryFn: () => fetchFileRoots(apiClient),
    refetchOnWindowFocus: true,
  });
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
    <>
      <SortableVerticalList
        ids={visibleIds}
        onReorder={reorder.onReorder}
        disabled={reorder.pending}
      >
        {roots.map((root) => (
          <SortableRootNode key={root.id} root={root} ctx={ctx} />
        ))}
      </SortableVerticalList>
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
    </>
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
  const { nodeKey, expanded, toggle, query, errCode } = useDirectoryListing(rootId, path);
  const upload = useDirectoryUpload(rootId, path, ctx.transferMaxBytes);

  useRsyncMissingToast({
    root,
    nodeKey,
    errCode,
    llmConfigured: ctx.llmConfigured,
    localDeviceId: ctx.localDeviceId,
  });

  const [showAll, setShowAll] = useState(false);

  const indent = depth * INDENT_STEP + 4;
  const childIndent = indent + 18;
  const entries = query.data?.entries;
  // 选中的文件落在上限之外时把上限撑到它，否则路由直达的那一行根本不会挂载
  const selected = useSelectedFilePath();
  const cap =
    entries && entries.length > DISPLAY_CAP && selected?.rootId === rootId
      ? Math.max(DISPLAY_CAP, entries.findIndex((entry) => entry.path === selected.path) + 1)
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
          <FileLeaf key={entry.path} entry={entry} root={root} depth={depth + 1} />
        )
      )}
      {hidden > 0 && (
        <button
          type="button"
          data-testid={`file-show-more-${rootId}-${path}`}
          onClick={() => setShowAll(true)}
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
    </DirectoryNodeView>
  );
});

const FileLeaf = memo(function FileLeaf({
  entry,
  root,
  depth,
}: { entry: FileEntryDto; root: FileRootDto; depth: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const runtime = useRuntime();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = useSelectedFilePath();
  const rootId = root.id;
  const isSelected = selected?.rootId === rootId && selected?.path === entry.path;
  const Icon = fileIconFor(entry);
  const indent = depth * INDENT_STEP + 4 + 18;
  const { download, dragHandlers } = useFileNodeActions(rootId, entry);

  const open = () => {
    navigate(hostAppPath(runtime.host, fileRoute(rootId, entry.path)));
    if (isMobile) setOpenMobile(false);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            draggable
            onClick={open}
            {...dragHandlers}
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
              <span
                className="shrink-0 text-[9px] text-muted-foreground/60"
                title={t('files.symlink')}
              >
                ↗
              </span>
            )}
          </button>
        }
      />
      <FileNodeMenuContent
        root={root}
        entry={entry}
        onOpen={open}
        onDownload={() => void download()}
      />
    </ContextMenu>
  );
});
