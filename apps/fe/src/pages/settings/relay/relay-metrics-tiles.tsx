// 指标磁贴：紧凑排（本机卡片）与完整排（中继标签）共用同一批格子，差别只在摆哪几个。

import { Skeleton } from '@vibeterm/ui/skeleton';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActiveStreamsTile,
  BandwidthTile,
  BytesInTile,
  BytesOutTile,
  CpuTile,
  EventLoopTile,
  FramesTile,
  LatencyTile,
  MembersOnlineTile,
  MemoryTile,
  type MetricsTileProps,
  ReconnectsTile,
  SocketsTile,
  TenantsTile,
  ThroughputTile,
  TrafficTile,
  UptimeTile,
} from './relay-metrics-tile-items';

export type { MetricsTileProps };
export { ThroughputTile };

/** 第二排的瘦格子：同一个磁贴，数值字号收一档。 */
const THIN_TILE = '[&_[data-slot=stat-tile-value]]:text-base';

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
const FULL_TILE_GRID = 'grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6';
/** 转发量一组八格，列数改取 8 的因数，末行才不缺角。 */
const WIDE_TILE_GRID = 'grid grid-cols-2 gap-3 lg:grid-cols-4';

function TileGroup({
  title,
  testId,
  gridClassName = FULL_TILE_GRID,
  children,
}: {
  title: string;
  testId: string;
  gridClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h4 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h4>
      <div className={gridClassName}>{children}</div>
    </section>
  );
}

/** 中继标签上的完整排：转发量一组、本机负载一组，各六格。 */
export function RelayFullTiles(props: MetricsTileProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4" data-testid="relay-metrics-tiles">
      <TileGroup
        title={t('relay.metrics.groups.traffic')}
        testId="relay-metrics-group-traffic"
        gridClassName={WIDE_TILE_GRID}
      >
        <TenantsTile {...props} />
        <MembersOnlineTile {...props} />
        <ActiveStreamsTile {...props} />
        <BandwidthTile {...props} />
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
