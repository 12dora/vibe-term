// 内容区没有视图可显示时的几种状态：加载骨架、出错、空目录、筛选无结果、根目录不可用。
// 它们同样是放置目标（可以往空目录里拖文件），事件处理由调用方透传。

import type { FileErrorCode } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { FolderOpen, FolderX, type LucideIcon, SearchX, TriangleAlert } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileErrorKey } from '../files/file-tree-logic';

export type ExplorerStateKind = 'loading' | 'error' | 'empty' | 'filtered' | 'rootMissing';

export interface ExplorerContentStateProps {
  kind: ExplorerStateKind;
  errorCode?: FileErrorCode;
  onRetry?(): void;
  /** 拖放 / 右键等事件处理，挂在整块区域上 */
  areaProps?: HTMLAttributes<HTMLDivElement>;
}

/** 骨架屏晚一点出现：缓存命中或请求很快时不闪一下 */
export const SKELETON_DELAY_MS = 150;
export const SKELETON_ROWS = 8;

const SKELETON_NAME_WIDTHS = ['w-40', 'w-56', 'w-32', 'w-48', 'w-36', 'w-52', 'w-28', 'w-44'];

const AREA_CLASS = 'flex h-full min-h-0 flex-col';

const MESSAGE_KEYS: Record<Exclude<ExplorerStateKind, 'loading' | 'error'>, string> = {
  empty: 'explorer.empty.folder',
  filtered: 'explorer.empty.filtered',
  rootMissing: 'explorer.state.rootMissing',
};

const MESSAGE_ICONS: Record<Exclude<ExplorerStateKind, 'loading'>, LucideIcon> = {
  empty: FolderOpen,
  filtered: SearchX,
  rootMissing: FolderX,
  error: TriangleAlert,
};

function useDelayedFlag(delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return elapsed;
}

function LoadingSkeleton() {
  const { t } = useTranslation();
  const visible = useDelayedFlag(SKELETON_DELAY_MS);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 加载占位是布局容器，<output> 的表单语义不适用
    <div
      role="status"
      aria-busy
      aria-label={t('common.loading')}
      data-testid="explorer-loading"
      data-visible={visible || undefined}
      className={cn(
        'flex flex-col gap-px px-1 pt-8 transition-opacity duration-(--vibeterm-motion-standard) ease-out motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0'
      )}
    >
      {SKELETON_NAME_WIDTHS.slice(0, SKELETON_ROWS).map((width) => (
        <div key={width} className="flex h-[30px] items-center gap-2 px-2">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className={cn('h-3', width)} />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

function CenteredMessage({
  icon: Icon,
  testId,
  children,
}: {
  icon: LucideIcon;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <Icon aria-hidden className="size-9 text-muted-foreground/50" strokeWidth={1.5} />
      {children}
    </div>
  );
}

const MESSAGE_TEXT_CLASS = 'max-w-xs text-[13px] text-muted-foreground';

export function ExplorerContentState({
  kind,
  errorCode,
  onRetry,
  areaProps,
}: ExplorerContentStateProps) {
  const { t } = useTranslation();
  if (kind === 'loading') {
    return (
      <div {...areaProps} className={AREA_CLASS}>
        <LoadingSkeleton />
      </div>
    );
  }
  if (kind === 'error') {
    return (
      <div {...areaProps} className={AREA_CLASS}>
        <CenteredMessage icon={MESSAGE_ICONS.error} testId="explorer-error">
          <p role="alert" className={MESSAGE_TEXT_CLASS}>
            {t(fileErrorKey(errorCode))}
          </p>
          {onRetry && (
            <Button variant="outline" size="sm" data-testid="explorer-retry" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )}
        </CenteredMessage>
      </div>
    );
  }
  return (
    <div {...areaProps} className={AREA_CLASS}>
      <CenteredMessage icon={MESSAGE_ICONS[kind]} testId={`explorer-state-${kind}`}>
        <p className={MESSAGE_TEXT_CLASS}>{t(MESSAGE_KEYS[kind])}</p>
      </CenteredMessage>
    </div>
  );
}
