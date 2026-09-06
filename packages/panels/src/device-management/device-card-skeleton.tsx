// 设备卡片的加载占位：与真实卡片同一套网格、同样的 `Card size="sm"` 与高度，
// 只是虚线空卡加一行「加载中」。用整块通知卡当占位会在列表到达时整块换成网格，
// 视觉上是「盒子消失、卡片弹出」。

import { cn } from '@vibeterm/ui';
import { Card, CardContent } from '@vibeterm/ui/card';
import { useTranslation } from 'react-i18next';

/** 与 `device-grid` 的网格保持一致：列宽、间距对不上，切换时就会跳一下。 */
export const DEVICE_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(min(24rem,100%),1fr))] gap-3';

export interface DeviceCardSkeletonProps {
  /** 占位卡片数量；缺省一张。 */
  count?: number;
  className?: string;
}

function slotKeys(count: number): string[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => `device-skeleton-${index}`);
}

export function DeviceCardSkeleton({ count = 1, className }: DeviceCardSkeletonProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="devices-loading"
      className={cn(DEVICE_GRID_CLASS, 'vibeterm-fade', className)}
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
