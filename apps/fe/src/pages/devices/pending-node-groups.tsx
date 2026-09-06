// 成员列表还在同步时，替「还没到的节点」占位。
//
// 加入中继后重启，证书已经在、状态块还没解开：此时只画本机那一组，看起来就是「别的节点没了」。
// 已经在成员列表里的那几台由各自的分组就地画占位，这里只补「列表里还没有」的那些，
// 版式与真实分组一致（分组头 + 卡片网格）。

import { DeviceCardSkeleton } from '@vibeterm/panels/device-management';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { useTranslation } from 'react-i18next';

/** 占位分组数量上限：待同步成员再多也不该把整页铺满。 */
export const MAX_PENDING_GROUPS = 4;

/**
 * 还得**另外**补几组占位。
 *
 * 待同步成员本身就在 `/api/mesh/nodes` 的成员集里（成员集由证书驱动），那几行已经作为分组
 * 画出来了（`nodeDeviceGroupState` 的 `pending` 档），再补一组匿名占位就成了重影。所以只给
 * 「列表里还没有」的那些补：网关下发了 id 就精确算差集，旧网关或列表一份都还没到时按一组算。
 */
export function missingPendingCount(input: {
  pendingMemberIds: string[] | null;
  listedIds: ReadonlySet<string>;
}): number {
  if (input.pendingMemberIds === null) return 1;
  return input.pendingMemberIds.filter((id) => !input.listedIds.has(id)).length;
}

export function pendingGroupKeys(count: number): string[] {
  const bounded = Math.min(MAX_PENDING_GROUPS, Math.max(0, count));
  return Array.from({ length: bounded }, (_, index) => `pending-node-${index}`);
}

export function PendingNodeGroups({ count }: { count: number }) {
  const keys = pendingGroupKeys(count);
  if (keys.length === 0) return null;
  return <PendingNodeGroupList keys={keys} />;
}

function PendingNodeGroupList({ keys }: { keys: string[] }) {
  const { t } = useTranslation();
  return (
    <div data-testid="devices-pending-nodes" className="flex min-w-0 flex-col gap-3">
      {keys.map((key) => (
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
