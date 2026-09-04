// 中继运行指标面板：状态条 + 磁贴排 + 趋势卡。
// 数据来自 5 秒一拍的 `relay-metrics-store`，由调用方（中继管理页）持有那条回路：
// 接入节点卡与本面板读同一份采样，回路只该起一条。

import { Button } from '@tmex/ui/button';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from './relay-format';
import { relayTrendSeries } from './relay-metrics-model';
import type { UseRelayMetricsResult } from './relay-metrics-store';
import { RelayFullTiles, RelayTilesSkeleton } from './relay-metrics-tiles';
import { RelayTrendsCard } from './relay-metrics-trends';

/** 刷新失败时的一行提示：不吃掉已有数据，只在旁边说明「这份是旧的」。 */
export function RelayMetricsRetryLine({
  message,
  onRetry,
  testId = 'relay-metrics-error',
}: {
  message: string;
  onRetry: () => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-testid={testId}
    >
      <span className="min-w-0 truncate">{t('relay.metrics.refreshFailed', { message })}</span>
      <Button size="xs" variant="ghost" onClick={onRetry} data-testid={`${testId}-retry`}>
        <RotateCw />
        {t('common.retry')}
      </Button>
    </div>
  );
}

export function RelayMetricsHeaderStrip({
  version,
  uptimeMs,
  tenants,
  stale,
}: {
  version: string;
  uptimeMs: number;
  tenants: number;
  stale: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      data-testid="relay-metrics-header"
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <span
          className={`size-2 rounded-full ${stale ? 'bg-amber-500' : 'bg-emerald-500'}`}
          aria-hidden
        />
        {t(stale ? 'relay.metrics.stale' : 'relay.metrics.header.running')}
      </span>
      <span data-testid="relay-metrics-version">
        {t('relay.metrics.header.version', { version })}
      </span>
      <span data-testid="relay-metrics-uptime">
        {t('relay.metrics.header.uptime', { duration: formatDuration(uptimeMs) })}
      </span>
      <span data-testid="relay-metrics-tenants">
        {t('relay.metrics.header.tenants', { n: tenants })}
      </span>
    </div>
  );
}

function RelayMetricsPanelSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="relay-metrics-panel-skeleton">
      <Skeleton className="h-4 w-64" />
      <RelayTilesSkeleton count={12} />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export interface RelayMetricsPanelProps {
  /** 采样回路由调用方持有，面板只读这一份快照。 */
  metrics: UseRelayMetricsResult;
}

export function RelayMetricsPanel({ metrics }: RelayMetricsPanelProps) {
  const { data, lastError } = metrics;

  if (metrics.unavailable) return null;

  if (data === null) {
    if (!lastError) return <RelayMetricsPanelSkeleton />;
    return (
      <RelayMetricsRetryLine
        message={lastError}
        onRetry={metrics.refresh}
        testId="relay-metrics-load-error"
      />
    );
  }

  const stale = lastError !== null;
  const trends = relayTrendSeries(data);

  return (
    <div className="flex flex-col gap-4" data-testid="relay-metrics-panel">
      <RelayMetricsHeaderStrip
        version={data.version}
        uptimeMs={data.uptimeMs}
        tenants={data.totals.tenants}
        stale={stale}
      />
      {stale && lastError && (
        <RelayMetricsRetryLine message={lastError} onRetry={metrics.refresh} />
      )}
      <RelayFullTiles data={data} trends={trends} stale={stale} />
      <Reveal delayMs={60}>
        <RelayTrendsCard trends={trends} />
      </Reveal>
    </div>
  );
}
