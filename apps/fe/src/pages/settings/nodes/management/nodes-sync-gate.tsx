// 成员列表还在同步时的节点表占位。
//
// 加入中继后重启，`/api/mesh/nodes` 会先返回一份成功但不完整的列表：直接画表会得到一张
// 只有本机（或名字是 raw id）的表，看起来像「其它节点都没了」。这里在同步完成前
// 用骨架行顶上，完成后再把真表挂出来。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { Skeleton } from '@vibeterm/ui/skeleton';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const ROW_KEYS = ['row-1', 'row-2', 'row-3'];

export function NodesSyncGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { loading } = useInventoryReadiness();
  if (!loading) return children;
  return (
    <div className="flex flex-col gap-2 vibeterm-fade" data-testid="nodes-syncing">
      <p className="text-xs text-muted-foreground">{t('nodes.loading.members')}</p>
      <Skeleton className="h-9 w-full" />
      {ROW_KEYS.map((key) => (
        <Skeleton key={key} className="h-11 w-full" />
      ))}
    </div>
  );
}
