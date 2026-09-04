// 本机作为中继时，节点卡上的紧凑指标区：四格主排 + 三格瘦排 + 一条通往中继控制台的链接。
//
// 数据源与「中继」标签是同一份宿主级 store，两处同时挂载也只有一条 5 秒轮询回路。

import { Button } from '@tmex/ui/button';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { relayTrendSeries } from '../../relay/relay-metrics-model';
import { RelayMetricsRetryLine } from '../../relay/relay-metrics-panel';
import { type RelayMetricsApi, useRelayMetrics } from '../../relay/relay-metrics-store';
import { RelayCompactTiles, RelayTilesSkeleton } from '../../relay/relay-metrics-tiles';

export type RelayServiceMetricsProps = {
  publicUrl: string | null;
  hasPassword: boolean;
  onOpenConsole?: () => void;
  api?: RelayMetricsApi;
};

export function RelayServiceMetrics({ onOpenConsole, api }: RelayServiceMetricsProps) {
  const { t } = useTranslation();
  const metrics = useRelayMetrics({ api });
  const { data, lastError } = metrics;

  if (metrics.unavailable) return null;

  if (data === null) {
    if (!lastError) {
      return <RelayTilesSkeleton count={4} testId="relay-service-metrics-skeleton" />;
    }
    return (
      <RelayMetricsRetryLine
        message={lastError}
        onRetry={metrics.refresh}
        testId="relay-service-metrics-error"
      />
    );
  }

  const stale = lastError !== null;

  return (
    <div className="flex flex-col gap-2" data-testid="relay-service-metrics">
      <RelayCompactTiles data={data} trends={relayTrendSeries(data)} stale={stale} />
      <div className="flex flex-wrap items-center gap-2">
        {stale && lastError && (
          <RelayMetricsRetryLine
            message={lastError}
            onRetry={metrics.refresh}
            testId="relay-service-metrics-stale"
          />
        )}
        {onOpenConsole && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={onOpenConsole}
            data-testid="relay-service-metrics-console"
          >
            {t('relay.metrics.console')}
            <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}
