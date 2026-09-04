// 指标磁贴：紧凑排（本机卡片）与完整排（中继标签）共用同一批格子，差别只在摆哪几个。

import { formatBytes } from '@tmex/api-client/format';
import type { RelayMetricsResponse } from '@tmex/api-client/relay/metrics-types';
import { Skeleton } from '@tmex/ui/skeleton';
import { Sparkline } from '@tmex/ui/sparkline';
import { StatTile } from '@tmex/ui/stat-tile';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatBytesPerSec,
  formatDuration,
  formatFramesPerSec,
  formatMs,
  formatPercent,
  trafficText,
} from './relay-format';
import {
  type RelayTrendSeries,
  cpuLevel,
  eventLoopLevel,
  levelTone,
  maxMemberRttMs,
  medianMemberRttMs,
  rttLevel,
  totalMemberReconnects,
} from './relay-metrics-model';

export interface MetricsTileProps {
  data: RelayMetricsResponse;
  trends: RelayTrendSeries;
  /** 刷新失败但保留了上一份采样。 */
  stale?: boolean;
}

/** 第二排的瘦格子：同一个磁贴，数值字号收一档。 */
const THIN_TILE = '[&_[data-slot=stat-tile-value]]:text-base';

const SPARK_WIDTH = 72;
const SPARK_HEIGHT = 24;

export function MembersOnlineTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const { totals } = data;
  return (
    <StatTile
      label={t('relay.metrics.tiles.membersOnline')}
      value={totals.membersOnline}
      sub={t('relay.metrics.tiles.membersOnlineSub', { total: totals.members })}
      tone={totals.membersOnline === 0 ? 'muted' : 'default'}
      stale={stale}
      data-testid="relay-metric-members-online"
    />
  );
}

export function ActiveStreamsTile({ data, trends, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  return (
    <StatTile
      label={t('relay.metrics.tiles.activeStreams')}
      value={data.totals.activeStreams}
      stale={stale}
      sparkline={
        <Sparkline
          values={trends.activeStreams.values}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          tone="muted"
        />
      }
      data-testid="relay-metric-active-streams"
    />
  );
}

/**
 * `showTotal` 是紧凑区的取法：那里没有单独的「累计流量」格子，
 * 累计量就挂在吞吐格的副行上，免得只剩瞬时速率、看不出转了多少。
 */
export function ThroughputTile({
  data,
  trends,
  stale,
  showTotal = false,
}: MetricsTileProps & { showTotal?: boolean }) {
  const { t } = useTranslation();
  const { totals } = data;
  return (
    <StatTile
      label={t('relay.metrics.tiles.throughput')}
      value={formatBytesPerSec(totals.bytesInPerSec + totals.bytesOutPerSec)}
      sub={
        showTotal
          ? t('relay.metrics.tiles.throughputTotal', { total: trafficText(totals.bytesOut) })
          : t('relay.metrics.tiles.throughputSub', {
              out: formatBytesPerSec(totals.bytesOutPerSec),
              in: formatBytesPerSec(totals.bytesInPerSec),
            })
      }
      stale={stale}
      sparkline={
        <Sparkline
          series={[
            { values: trends.bytesOut.values, tone: 'accent', fill: true },
            { values: trends.bytesIn.values, tone: 'success' },
          ]}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
        />
      }
      data-testid="relay-metric-throughput"
    />
  );
}

export function BytesInTile({ data, trends, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  return (
    <StatTile
      label={t('relay.metrics.tiles.bytesIn')}
      value={formatBytesPerSec(data.totals.bytesInPerSec)}
      stale={stale}
      sparkline={
        <Sparkline
          values={trends.bytesIn.values}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          tone="success"
          fill
        />
      }
      data-testid="relay-metric-bytes-in"
    />
  );
}

export function BytesOutTile({ data, trends, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  return (
    <StatTile
      label={t('relay.metrics.tiles.bytesOut')}
      value={formatBytesPerSec(data.totals.bytesOutPerSec)}
      stale={stale}
      sparkline={
        <Sparkline
          values={trends.bytesOut.values}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          tone="accent"
          fill
        />
      }
      data-testid="relay-metric-bytes-out"
    />
  );
}

export function FramesTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const { totals } = data;
  return (
    <StatTile
      label={t('relay.metrics.tiles.frames')}
      value={formatFramesPerSec(totals.framesInPerSec + totals.framesOutPerSec)}
      unit="fps"
      sub={t('relay.metrics.tiles.framesSub', {
        out: formatFramesPerSec(totals.framesOutPerSec),
        in: formatFramesPerSec(totals.framesInPerSec),
      })}
      stale={stale}
      data-testid="relay-metric-frames"
    />
  );
}

export function LatencyTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const median = medianMemberRttMs(data.members);
  const max = maxMemberRttMs(data.members);
  return (
    <StatTile
      label={t('relay.metrics.tiles.rtt')}
      value={formatMs(median)}
      hint={t('relay.metrics.tiles.rttHint')}
      sub={
        max === null
          ? t('relay.metrics.tiles.eventLoopSub', {
              max: formatMs(data.process.eventLoop.lagMs),
            })
          : t('relay.metrics.tiles.rttSub', { max: formatMs(max) })
      }
      tone={levelTone(rttLevel(median))}
      stale={stale}
      data-testid="relay-metric-rtt"
    />
  );
}

export function EventLoopTile({ data, trends, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const { eventLoop } = data.process;
  return (
    <StatTile
      label={t('relay.metrics.tiles.eventLoop')}
      value={formatMs(eventLoop.lagMs)}
      hint={t('relay.metrics.tiles.eventLoopHint')}
      sub={t('relay.metrics.tiles.eventLoopSub', { max: formatMs(eventLoop.maxLagMs) })}
      tone={levelTone(eventLoopLevel(eventLoop.lagMs))}
      stale={stale}
      sparkline={
        <Sparkline
          values={trends.eventLoopLagMs.values}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          tone="warning"
        />
      }
      data-testid="relay-metric-event-loop"
    />
  );
}

/**
 * 常驻内存（RSS）。`showHeapTotal` 是完整排的取法：那里没有单独的堆格子，
 * 堆的已用 / 总量一并挂在副行上；紧凑排位置窄，只留已用量。
 */
export function MemoryTile({
  data,
  stale,
  className,
  showHeapTotal = false,
}: MetricsTileProps & { className?: string; showHeapTotal?: boolean }) {
  const { t } = useTranslation();
  const { memory } = data.process;
  const heap = formatBytes(memory.heapUsedBytes);
  return (
    <StatTile
      label={t('relay.metrics.tiles.memory')}
      value={formatBytes(memory.rssBytes)}
      sub={
        showHeapTotal
          ? t('relay.metrics.tiles.memoryHeapSub', {
              heap,
              total: formatBytes(memory.heapTotalBytes),
            })
          : t('relay.metrics.tiles.memorySub', { heap })
      }
      stale={stale}
      className={className}
      data-testid="relay-metric-memory"
    />
  );
}

export function CpuTile({ data, stale, className }: MetricsTileProps & { className?: string }) {
  const { t } = useTranslation();
  const pct = data.process.cpu.utilizationPct;
  return (
    <StatTile
      label={t('relay.metrics.tiles.cpu')}
      value={formatPercent(pct)}
      tone={levelTone(cpuLevel(pct))}
      stale={stale}
      className={className}
      data-testid="relay-metric-cpu"
    />
  );
}

/**
 * 累计转发流量。中继每转发一帧都同时计进 `bytesIn` 与 `bytesOut`，两个计数逐字节相等，
 * 摆两列只会让人以为统计坏了——沿用旧「总量」卡的口径，只出一个数（见 relay-format 的 trafficText）。
 */
export function TrafficTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  return (
    <StatTile
      label={t('relay.metrics.tiles.traffic')}
      value={trafficText(data.totals.bytesOut)}
      sub={t('relay.metrics.tiles.trafficSub')}
      hint={t('relay.metrics.tiles.trafficHint')}
      stale={stale}
      data-testid="relay-metric-traffic"
    />
  );
}

export function SocketsTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const { openSockets, authenticatedLinks } = data.process;
  return (
    <StatTile
      label={t('relay.metrics.tiles.sockets')}
      value={openSockets}
      sub={t('relay.metrics.tiles.socketsSub', { authenticated: authenticatedLinks })}
      stale={stale}
      data-testid="relay-metric-sockets"
    />
  );
}

/** 各成员重连次数之和：单看在线数看不出链路在反复抖动，这一格才看得出来。 */
export function ReconnectsTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const total = totalMemberReconnects(data.members);
  return (
    <StatTile
      label={t('relay.metrics.tiles.reconnects')}
      value={total}
      sub={t('relay.metrics.tiles.reconnectsSub')}
      hint={t('relay.metrics.tiles.reconnectsHint')}
      tone={total === 0 ? 'muted' : 'default'}
      stale={stale}
      data-testid="relay-metric-reconnects"
    />
  );
}

export function UptimeTile({ data, stale, className }: MetricsTileProps & { className?: string }) {
  const { t } = useTranslation();
  return (
    <StatTile
      label={t('relay.metrics.tiles.uptime')}
      value={formatDuration(data.uptimeMs)}
      stale={stale}
      className={className}
      data-testid="relay-metric-uptime"
    />
  );
}

/** 本机卡片上的紧凑排：主排四格 + 一条瘦排。 */
export function RelayCompactTiles(props: MetricsTileProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="relay-metrics-compact">
      {/* 320–375px 下两列会把「16.0 KB/s」这类读数挤掉：基础断点单列，sm 两列，lg 四列。 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MembersOnlineTile {...props} />
        <ActiveStreamsTile {...props} />
        <ThroughputTile {...props} showTotal />
        <LatencyTile {...props} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <MemoryTile {...props} className={THIN_TILE} />
        <CpuTile {...props} className={THIN_TILE} />
        <UptimeTile {...props} className={THIN_TILE} />
      </div>
    </div>
  );
}

/**
 * 完整排的栅格：1280px 视口下面板本身只有 ~880px，六列会把「1.20 MB/s」这类读数压掉，
 * 六列因此留给 2xl。列数只取 6 的因数（每组六格），否则末行会缺角。
 */
const FULL_TILE_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6';

function TileGroup({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h4 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h4>
      <div className={FULL_TILE_GRID}>{children}</div>
    </section>
  );
}

/** 中继标签上的完整排：转发量一组、本机负载一组，各六格。 */
export function RelayFullTiles(props: MetricsTileProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4" data-testid="relay-metrics-tiles">
      <TileGroup title={t('relay.metrics.groups.traffic')} testId="relay-metrics-group-traffic">
        <MembersOnlineTile {...props} />
        <ActiveStreamsTile {...props} />
        <BytesInTile {...props} />
        <BytesOutTile {...props} />
        <FramesTile {...props} />
        <TrafficTile {...props} />
      </TileGroup>
      <TileGroup title={t('relay.metrics.groups.process')} testId="relay-metrics-group-process">
        <LatencyTile {...props} />
        <EventLoopTile {...props} />
        <MemoryTile {...props} showHeapTotal />
        <CpuTile {...props} />
        <SocketsTile {...props} />
        <ReconnectsTile {...props} />
      </TileGroup>
    </div>
  );
}

/** 首次加载：磁贴位置先摆骨架，别让卡片高度在数据到位时跳一下。 */
export function RelayTilesSkeleton({ count, testId }: { count: number; testId?: string }) {
  return (
    <div
      className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
      data-testid={testId ?? 'relay-metrics-skeleton'}
    >
      {Array.from({ length: count }, (_, index) => `tile-${index}`).map((key) => (
        <Skeleton key={key} className="h-[4.5rem] w-full rounded-xl" />
      ))}
    </div>
  );
}
