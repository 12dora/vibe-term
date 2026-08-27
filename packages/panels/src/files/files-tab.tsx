import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileEntryDto, FileRootDto, SystemInfo } from '@tmex/shared';
import { Loader2, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';

import { fetchDevices, fetchFileRoots, fetchLlmProviders } from '@tmex/api-client';
import { decodeFileRef, fileRoute, hostAppPath } from '@tmex/stores';
import { useFileTreeStore, useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@tmex/ui/context-menu';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { SidebarGroup, useSidebar } from '@tmex/ui/sidebar';
import { DirectoryNodeView } from './directory-node-view';
import { fileIconColor, fileIconFor } from './file-icon';
import { FileNodeMenuContent, useFileNodeActions } from './file-node-actions';
import { NodeError } from './node-menu';
import { useDirectoryListing } from './use-directory-listing';
import { hasExternalFiles, useDirectoryUpload } from './use-directory-upload';
import { useRsyncMissingToast } from './use-rsync-missing-toast';

const DEFAULT_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const INDENT_STEP = 12;

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

export interface FilesTabProps {
  /** 不渲染头部行（标题 + 刷新按钮）；宿主连续渲染多个实例时避免重复头部。 */
  hideHeader?: boolean;
}

// 外壳门：runtime.features.filesUi 关断时不渲染文件树，也不发起 files 查询（内层 hooks 不执行）。
export function FilesTab(props: FilesTabProps = {}) {
  const { features } = useRuntime();
  if (!features.filesUi) return null;
  return <FilesTabInner {...props} />;
}

function FilesTabInner({ hideHeader }: FilesTabProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();
  const isFetching = useIsFetching({ queryKey: ['files'] });
  const pruneStaleRoots = useFileTreeStore((s) => s.pruneStaleRoots);

  const rootsQuery = useQuery({
    queryKey: ['files', 'roots'],
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

  const roots = useMemo(
    () => (rootsQuery.data?.roots ?? []).filter((r) => r.enabled),
    [rootsQuery.data]
  );

  // 加载后清理陈旧的持久化展开键（根/设备已不存在）
  useEffect(() => {
    if (rootsQuery.data) pruneStaleRoots(rootsQuery.data.roots.map((r) => r.id));
  }, [rootsQuery.data, pruneStaleRoots]);

  const ctx: TreeContext = {
    llmConfigured: (providersQuery.data?.providers ?? []).length > 0,
    localDeviceId: devicesQuery.data?.devices.find((d) => d.type === 'local')?.id ?? null,
    transferMaxBytes: systemInfoQuery.data?.transferMaxBytes ?? DEFAULT_TRANSFER_MAX_BYTES,
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['files'] });

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col pt-0" data-testid="files-tab">
      {!hideHeader && (
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {t('files.title')}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={refresh}
            title={t('files.refresh')}
            data-testid="files-refresh"
          >
            <RotateCw className={cn('h-3.5 w-3.5', isFetching > 0 && 'animate-spin')} />
          </Button>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div
          // 兜底：阻止把文件拖到非文件夹区域时浏览器默认打开/导航；真正的上传由 DirNode 的 onDrop 处理
          onDragOver={(e) => {
            if (hasExternalFiles(e)) e.preventDefault();
          }}
          onDrop={(e) => {
            if (hasExternalFiles(e)) e.preventDefault();
          }}
          className="space-y-0.5 pr-1 pb-2 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]"
        >
          {roots.map((root) => (
            <DirNode
              key={root.id}
              root={root}
              rootId={root.id}
              path={root.path}
              depth={0}
              isRoot
              ctx={ctx}
            />
          ))}
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
        </div>
      </ScrollArea>
    </SidebarGroup>
  );
}

// 递归的目录节点：把数据（列表 + 轮询）、上传、rsync 提示三块副作用交给对应 hooks，
// 自身只负责组合与递归渲染子节点。
function DirNode({
  root,
  rootId,
  path,
  depth,
  isRoot,
  ctx,
}: {
  root: FileRootDto;
  rootId: string;
  path: string;
  depth: number;
  isRoot: boolean;
  ctx: TreeContext;
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

  const indent = depth * INDENT_STEP + 4;
  const childIndent = indent + 18;

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
      {query.data?.entries.map((entry) =>
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
}

function FileLeaf({
  entry,
  root,
  depth,
}: { entry: FileEntryDto; root: FileRootDto; depth: number }) {
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
              <span className="shrink-0 text-[9px] text-muted-foreground/60" title="symlink">
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
}
