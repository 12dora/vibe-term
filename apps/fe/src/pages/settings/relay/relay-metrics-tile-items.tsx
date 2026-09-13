// 中继指标的单个磁贴。紧凑排与完整排共用同一批格子，差别只在摆哪几个。

import { formatBytes, formatRate } from '@vibeterm/api-client/format';
import type { RelayMetricsResponse } from '@vibeterm/api-client/relay/metrics-types';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import { Sparkline } from '@vibeterm/ui/sparkline';
import { StatTile } from '@vibeterm/ui/stat-tile';
import { useTranslation } from 'react-i18next';
import {
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
      value={<ByteRate>{formatRate(totals.bytesInPerSec + totals.bytesOutPerSec)}</ByteRate>}
      sub={
        showTotal
          ? t('relay.metrics.tiles.throughputTotal', { total: trafficText(totals.bytesOut) })
          : t('relay.metrics.tiles.throughputSub', {
              out: formatRate(totals.bytesOutPerSec),
              in: formatRate(totals.bytesInPerSec),
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
      value={<ByteRate>{formatRate(data.totals.bytesInPerSec)}</ByteRate>}
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
      value={<ByteRate>{formatRate(data.totals.bytesOutPerSec)}</ByteRate>}
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
      value={<ByteRate>{formatBytes(memory.rssBytes)}</ByteRate>}
      sub={
        showHeapTotal
          ? t('relay.metrics.tiles.memoryHeapSub', {
              heap,
              total: formatBytes(Math.max(memory.heapTotalBytes, memory.heapUsedBytes)),
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
      value={<ByteRate>{trafficText(data.totals.bytesOut)}</ByteRate>}
      sub={t('relay.metrics.tiles.trafficSub')}
      hint={t('relay.metrics.tiles.trafficHint')}
      stale={stale}
      data-testid="relay-metric-traffic"
    />
  );
}

/**
 * 中继级带宽：已放行速率与配置上限。没配上限时只出速率，不摆「/ 不限」那种半句话。
 */
export function BandwidthTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const { totals } = data;
  const used = formatRate(totals.bandwidthBytesPerSec ?? 0);
  const limit = totals.bandwidthLimitBytesPerSec ?? null;
  return (
    <StatTile
      label={t('relay.metrics.tiles.bandwidth')}
      value={
        limit === null ? (
          <ByteRate>{used}</ByteRate>
        ) : (
          // 「已用 / 上限」两段拼成一个字符串就没法分别定宽，而整串最长要 25ch、磁贴放不下。
          // 上限是配置常量、刷新时不变，只给会变的「已用」留位置：`used` 为空即取模板的分隔部分。
          <span className="whitespace-nowrap">
            <ByteRate>{used}</ByteRate>
            {t('relay.metrics.tiles.usedOfLimit', { used: '', limit: formatRate(limit) })}
          </span>
        )
      }
      sub={
        limit === null
          ? t('relay.metrics.tiles.bandwidthUnlimited')
          : t(
              totals.fairShare === false
                ? 'relay.metrics.tiles.bandwidthFcfs'
                : 'relay.metrics.tiles.bandwidthFair'
            )
      }
      hint={t('relay.metrics.tiles.bandwidthHint')}
      stale={stale}
      data-testid="relay-metric-bandwidth"
    />
  );
}

/** 租户数与上限。上限未配置时只出当前数。 */
export function TenantsTile({ data, stale }: MetricsTileProps) {
  const { t } = useTranslation();
  const { totals } = data;
  const max = totals.maxTenants ?? null;
  return (
    <StatTile
      label={t('relay.metrics.tiles.tenants')}
      value={
        max === null
          ? totals.tenants
          : t('relay.metrics.tiles.usedOfLimit', { used: totals.tenants, limit: max })
      }
      sub={max === null ? t('relay.metrics.tiles.tenantsUnlimited') : undefined}
      stale={stale}
      data-testid="relay-metric-tenants"
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
