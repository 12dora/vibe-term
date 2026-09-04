// 中继运行指标面板：状态条 + 磁贴排 + 趋势卡 + 接入节点表。
// 数据来自 5 秒一拍的 `relay-metrics-store`；本面板拥有那条回路（页面隐藏时自动跳拍）。

import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from './relay-format';
import { RelayMembersTable } from './relay-metrics-members';
import { relayTrendSeries } from './relay-metrics-model';
import { type RelayMetricsApi, useRelayMetrics } from './relay-metrics-store';
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
      <RelayTilesSkeleton count={8} />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export interface RelayMetricsPanelProps {
  api?: RelayMetricsApi;
}

export function RelayMetricsPanel({ api }: RelayMetricsPanelProps = {}) {
  const { t } = useTranslation();
  const metrics = useRelayMetrics({ api });
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
  const now = metrics.loadedAt ?? data.sampledAt;

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
      <Reveal delayMs={120}>
        <Card data-testid="relay-members-card">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>{t('relay.metrics.members.title')}</CardTitle>
            <span className="text-xs text-muted-foreground" data-testid="relay-members-total">
              {t('relay.metrics.members.total', { n: data.members.length })}
            </span>
          </CardHeader>
          <CardContent>
            <RelayMembersTable members={data.members} now={now} />
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}
