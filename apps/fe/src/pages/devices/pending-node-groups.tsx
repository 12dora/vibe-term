// 成员列表还在同步时，替「还没到的节点」占位。
//
// 加入中继后重启，证书已经在、状态块还没解开：此时只画本机那一组，看起来就是「别的节点没了」。
// 这里按网关给的待同步成员数摆同样数量的分组骨架，与真实分组同一套版式（分组头 + 卡片网格）。

import { DeviceCardSkeleton } from '@vibeterm/panels/device-management';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { useTranslation } from 'react-i18next';

/** 占位分组数量上限：待同步成员再多也不该把整页铺满。 */
export const MAX_PENDING_GROUPS = 4;

/** 网关没下发待同步数（旧网关）时按一组算：有加载态就说明至少还差一台。 */
export function pendingGroupKeys(pendingMembers: number | null): string[] {
  const count = Math.min(MAX_PENDING_GROUPS, Math.max(1, pendingMembers ?? 1));
  return Array.from({ length: count }, (_, index) => `pending-node-${index}`);
}

export function PendingNodeGroups({ pendingMembers }: { pendingMembers: number | null }) {
  const { t } = useTranslation();
  return (
    <div data-testid="devices-pending-nodes" className="flex min-w-0 flex-col gap-3">
      {pendingGroupKeys(pendingMembers).map((key) => (
        <section key={key} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Skeleton className="h-4 w-24" />
            <span className="text-[11px] text-muted-foreground">{t('common.loading')}</span>
          </div>
          <DeviceCardSkeleton />
        </section>
      ))}
    </div>
  );
}
