// 趋势卡：近 5 分钟采样窗口的三张大图（吞吐叠画进出、活跃流、事件循环延迟）。
// 每张图右上角标出这段窗口里的峰值与谷值——没有坐标轴的折线，端点标注就是唯一的量纲。

import { formatRate } from '@tmex/api-client/format';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Sparkline, type SparklineTone } from '@tmex/ui/sparkline';
import { useTranslation } from 'react-i18next';
import { formatDuration, formatMs } from './relay-format';
import type { MetricSeries, RelayTrendSeries } from './relay-metrics-model';

const CHART_WIDTH = 480;
const CHART_HEIGHT = 64;

interface TrendChartProps {
  title: string;
  testId: string;
  series: MetricSeries[];
  tones: SparklineTone[];
  format: (value: number) => string;
  legend?: { label: string; tone: SparklineTone }[];
}

function toneDot(tone: SparklineTone): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-500';
    case 'accent':
      return 'bg-sky-500';
    case 'warning':
      return 'bg-amber-500';
    case 'destructive':
      return 'bg-destructive';
    case 'muted':
      return 'bg-muted-foreground';
    default:
      return 'bg-[color:var(--chart-1,var(--primary))]';
  }
}

function TrendChart({ title, testId, series, tones, format, legend }: TrendChartProps) {
  const { t } = useTranslation();
  const max = Math.max(...series.map((one) => one.max), 0);
  const min = Math.min(...series.map((one) => one.min));
  const empty = series.every((one) => one.values.length === 0);

  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h4 className="text-xs font-medium">{title}</h4>
          {legend?.map((item) => (
            <span
              key={item.label}
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <span className={`size-1.5 rounded-full ${toneDot(item.tone)}`} aria-hidden />
              {item.label}
            </span>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {empty
            ? t('relay.metrics.empty')
            : t('relay.metrics.trends.range', {
                max: format(max),
                min: format(Number.isFinite(min) ? min : 0),
              })}
        </span>
      </header>
      <Sparkline
        className="h-16 w-full"
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        ariaLabel={title}
        series={series.map((one, index) => ({
          values: one.values,
          tone: tones[index] ?? 'default',
          fill: index === 0,
        }))}
      />
    </section>
  );
}

export function RelayTrendsCard({ trends }: { trends: RelayTrendSeries }) {
  const { t } = useTranslation();
  return (
    <Card data-testid="relay-metrics-trends">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{t('relay.metrics.trends.title')}</CardTitle>
        <span className="text-xs text-muted-foreground" data-testid="relay-metrics-trends-window">
          {t('relay.metrics.trends.window', { duration: formatDuration(trends.windowMs) })}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <TrendChart
          title={t('relay.metrics.trends.throughput')}
          testId="relay-trend-throughput"
          series={[trends.bytesOut, trends.bytesIn]}
          tones={['accent', 'success']}
          format={formatRate}
          legend={[
            { label: t('relay.metrics.trends.legendOut'), tone: 'accent' },
            { label: t('relay.metrics.trends.legendIn'), tone: 'success' },
          ]}
        />
        <TrendChart
          title={t('relay.metrics.trends.streams')}
          testId="relay-trend-streams"
          series={[trends.activeStreams]}
          tones={['default']}
          format={(value) => String(Math.round(value))}
        />
        <TrendChart
          title={t('relay.metrics.trends.eventLoop')}
          testId="relay-trend-event-loop"
          series={[trends.eventLoopLagMs]}
          tones={['warning']}
          format={(value) => formatMs(value)}
        />
      </CardContent>
    </Card>
  );
}
