// 空态：整个工作区没有标签页（完整版，带入口节点目录根的快捷打开），或某个分栏被清空（紧凑版）。
// 渲染在页面级运行时之下（文件管理器路由不带节点前缀，这里的运行时就是入口节点）。

import { useQuery } from '@tanstack/react-query';
import { fetchFileRoots } from '@vibeterm/api-client';
import type { FileRootDto } from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { staggerItemStyle } from '@vibeterm/ui/motion';
import { Folder, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkspaceActions } from './workspace-actions';

const ROOT_BUTTON_CLASS =
  'flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border/60 bg-background px-3 py-2 text-left text-sm outline-none transition-[color,background-color,border-color,box-shadow] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none hover:border-border hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function RootButton({ root, index }: { root: FileRootDto; index: number }) {
  const runtime = useRuntime();
  const { openLocation } = useWorkspaceActions();
  return (
    <button
      type="button"
      style={staggerItemStyle(index)}
      className={ROOT_BUTTON_CLASS}
      onClick={() => openLocation({ nodeId: runtime.nodeId, rootId: root.id, path: root.path })}
    >
      <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{root.name}</span>
      {root.deviceName && (
        <span className="max-w-[40%] shrink-0 truncate text-muted-foreground text-xs">
          {root.deviceName}
        </span>
      )}
    </button>
  );
}

function QuickOpenRoots() {
  const runtime = useRuntime();
  const rootsQuery = useQuery({
    queryKey: ['files', 'roots'],
    queryFn: () => fetchFileRoots(runtime.apiClient),
    throwOnError: false,
  });
  const roots = (rootsQuery.data?.roots ?? []).filter((root) => root.enabled);
  if (roots.length === 0) return null;
  return (
    <div className="vibeterm-stagger mt-2 flex w-full max-w-sm flex-col gap-1.5">
      {roots.map((root, index) => (
        <RootButton key={root.id} root={root} index={index} />
      ))}
    </div>
  );
}

export function ExplorerEmpty({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="explorer-empty"
      data-compact={compact || undefined}
      className="vibeterm-fade flex h-full min-h-0 flex-col items-center overflow-y-auto"
    >
      {/* my-auto 居中：内容比容器高时从顶部开始滚，不会被裁掉上半截 */}
      <div
        className={cn(
          'my-auto flex w-full flex-col items-center gap-2 text-center',
          compact ? 'p-4' : 'p-6'
        )}
      >
        <FolderOpen
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn('text-muted-foreground/70', compact ? 'size-6' : 'size-8')}
        />
        <p className="font-medium text-sm">{t('explorer.empty.title')}</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          {t('explorer.empty.desc')}
        </p>
        {!compact && <QuickOpenRoots />}
      </div>
    </div>
  );
}
