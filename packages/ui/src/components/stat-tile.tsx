// 指标磁贴：一个标签 + 一个大数 + 可选副行/迷你折线。监控面板里成排出现，
// 所以数字统一走 `tabular-nums`——刷新时位数变化不会让整排跟着抖。

import type * as React from 'react';

import { cn } from '../utils';
import { Card, CardContent } from './card';
import { Skeleton } from './skeleton';

export type StatTileTone = 'default' | 'success' | 'warning' | 'destructive' | 'muted';

const VALUE_TONE_CLASS: Record<StatTileTone, string> = {
  default: 'text-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

export interface StatTileProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  label: string;
  value?: React.ReactNode;
  /** 跟在数值后的单位，字号更小且不参与 tone 着色。 */
  unit?: string;
  /** 副行：一句更细的补充（如 ↑ 12.3 KB/s · ↓ 4.1 KB/s）。 */
  sub?: React.ReactNode;
  tone?: StatTileTone;
  /** 右侧（窄屏下移到底部）的迷你折线槽位。 */
  sparkline?: React.ReactNode;
  /** 首次加载：数值与副行换成骨架。 */
  loading?: boolean;
  /** 数据已过期（刷新失败但保留上一份）：整块降透明度。 */
  stale?: boolean;
  /** 悬停说明，用来解释标签里放不下的口径。 */
  hint?: string;
}

export function StatTile({
  label,
  value,
  unit,
  sub,
  tone = 'default',
  sparkline,
  loading = false,
  stale = false,
  hint,
  className,
  ...props
}: StatTileProps) {
  return (
    <Card
      size="sm"
      data-slot="stat-tile"
      data-tone={tone}
      data-stale={stale ? '' : undefined}
      title={hint}
      className={cn(
        'gap-0 transition-opacity duration-(--tmex-motion-fast) motion-reduce:transition-none',
        stale && 'opacity-60',
        className
      )}
      {...props}
    >
      <CardContent className="flex min-w-0 items-end justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[10px] font-medium tracking-wider text-muted-foreground uppercase"
            data-slot="stat-tile-label"
          >
            {label}
          </div>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-16" />
          ) : (
            <div className="mt-0.5 flex items-baseline gap-1">
              <span
                className={cn(
                  'truncate text-xl leading-tight font-semibold tabular-nums',
                  VALUE_TONE_CLASS[tone]
                )}
                data-slot="stat-tile-value"
              >
                {value ?? '—'}
              </span>
              {unit && (
                <span className="shrink-0 text-xs text-muted-foreground" data-slot="stat-tile-unit">
                  {unit}
                </span>
              )}
            </div>
          )}
          {loading ? (
            <Skeleton className="mt-1.5 h-3 w-24" />
          ) : (
            sub && (
              <div
                className="mt-1 truncate text-[11px] text-muted-foreground tabular-nums"
                data-slot="stat-tile-sub"
              >
                {sub}
              </div>
            )
          )}
        </div>
        {sparkline && !loading && (
          <div className="shrink-0 self-end" data-slot="stat-tile-sparkline">
            {sparkline}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
