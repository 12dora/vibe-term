// 底部状态栏：项目数、选中数与合计大小、截断提示。

import { formatBytes } from '@vibeterm/api-client';
import { cn } from '@vibeterm/ui';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface ExplorerStatusBarProps {
  total: number;
  selectedCount: number;
  selectedBytes: number | null;
  truncated: boolean;
}

export function ExplorerStatusBar({
  total,
  selectedCount,
  selectedBytes,
  truncated,
}: ExplorerStatusBarProps) {
  const { t } = useTranslation();
  const hasSelection = selectedCount > 0;
  // 淡出期间继续显示上一次的选中数，避免先跳成「0 项」再消失
  const lastShown = useRef({ count: selectedCount, bytes: selectedBytes });
  if (hasSelection) lastShown.current = { count: selectedCount, bytes: selectedBytes };
  const shown = lastShown.current;

  return (
    // biome-ignore lint/a11y/useSemanticElements: 状态栏是布局容器，<output> 的表单语义不适用
    <div
      role="status"
      data-testid="explorer-status"
      className="flex h-[26px] shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground tabular-nums"
    >
      <span className="shrink-0" data-testid="explorer-status-items">
        {t('explorer.status.items', { count: total })}
      </span>
      <span
        data-testid="explorer-status-selected"
        data-visible={hasSelection || undefined}
        aria-hidden={!hasSelection}
        className={cn(
          'flex min-w-0 items-center gap-1.5 truncate transition-opacity duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
          hasSelection ? 'opacity-100' : 'opacity-0'
        )}
      >
        <span>{t('explorer.status.selected', { count: shown.count })}</span>
        {shown.bytes != null && (
          <>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span data-testid="explorer-status-bytes">{formatBytes(shown.bytes)}</span>
          </>
        )}
      </span>
      {truncated && (
        <span className="ml-auto shrink-0" data-testid="explorer-status-truncated">
          {t('explorer.status.truncated', { count: total })}
        </span>
      )}
    </div>
  );
}
