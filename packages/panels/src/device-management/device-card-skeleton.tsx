// 设备卡片的加载占位：与真实卡片同一套网格、同样的 `Card size="sm"` 与高度，
// 只是虚线空卡加一行「加载中」。用整块通知卡当占位会在列表到达时整块换成网格，
// 视觉上是「盒子消失、卡片弹出」。

import { cn } from '@vibeterm/ui';
import { Card, CardContent } from '@vibeterm/ui/card';
import { useTranslation } from 'react-i18next';

/**
 * 与 `device-grid` 的网格保持一致：列宽、间距对不上，切换时就会跳一下。
 * 每列至少 20rem（设备名与 SSH 目标要有地方放），窄于它退回单列。
 */
export const DEVICE_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))] gap-3';

/**
 * 节点磁贴里用的变体：`auto-fit` 把空轨道收掉，卡片均分磁贴的宽度——单设备节点的那张卡
 * 占满整格，N 台设备的节点跨 N 格时正好并排 N 张。
 */
export const DEVICE_GRID_FIT_CLASS =
  'grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-3';

/** 骨架与真实网格都从这里取类名，两边永远是同一套列模型 */
export function deviceGridClass(fit = false): string {
  return fit ? DEVICE_GRID_FIT_CLASS : DEVICE_GRID_CLASS;
}

export interface DeviceCardSkeletonProps {
  /** 占位卡片数量；缺省一张。 */
  count?: number;
  /** 卡片均分容器宽度（节点磁贴里用），见 `DEVICE_GRID_FIT_CLASS` */
  fit?: boolean;
  className?: string;
}

function slotKeys(count: number): string[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => `device-skeleton-${index}`);
}

export function DeviceCardSkeleton({ count = 1, fit, className }: DeviceCardSkeletonProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="devices-loading"
      className={cn(deviceGridClass(fit), 'vibeterm-fade', className)}
    >
      {slotKeys(count).map((key) => (
        <Card
          key={key}
          size="sm"
          aria-hidden="true"
          className="gap-2 border border-dashed border-border/60 bg-muted/20 py-2.5 ring-0"
        >
          <CardContent className="flex h-14 items-center justify-center text-xs text-muted-foreground">
            {t('common.loading')}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
