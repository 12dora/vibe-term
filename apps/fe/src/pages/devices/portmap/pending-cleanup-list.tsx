// 待清理放行：映射已经删了，但目标节点上的放行记录还在。列出来并提供重试，
// 否则这条放行会一直有效——拿着同一个 mapId 的监听方仍能连上目标服务。

import { Button } from '@vibeterm/ui/button';
import { useTranslation } from 'react-i18next';

import type { DialogNodeOption } from '../dialog-nodes';
import type { PendingExportCleanup } from './pending-cleanup';

/** 目标节点展示名：按真实 mesh id 找，找不到就退回短 id。 */
export function cleanupNodeName(
  record: PendingExportCleanup,
  options: readonly DialogNodeOption[]
): string {
  const option = options.find((item) => item.meshId === record.targetMeshId);
  return option?.name ?? record.targetMeshId.slice(0, 8);
}

/** 目标节点当前是否可请求；不可用时重试按钮禁用。 */
export function cleanupRetryable(
  record: PendingExportCleanup,
  options: readonly DialogNodeOption[]
): boolean {
  return options.some((item) => item.meshId === record.targetMeshId && item.usable);
}

export interface PendingCleanupListProps {
  records: readonly PendingExportCleanup[];
  options: DialogNodeOption[];
  busyId: string | null;
  onRetry: (record: PendingExportCleanup) => void;
}

export function PendingCleanupList({ records, options, busyId, onRetry }: PendingCleanupListProps) {
  const { t } = useTranslation();
  if (records.length === 0) return null;

  return (
    <section
      className="flex flex-col gap-1 rounded-lg border border-destructive/40 p-2"
      data-testid="portmap-pending-cleanup"
    >
      <span className="text-xs font-medium">{t('devices.portmap.cleanup.title')}</span>
      <p className="text-[10px] text-muted-foreground">
        {t('devices.portmap.cleanup.description')}
      </p>
      {records.map((record) => {
        const retryable = cleanupRetryable(record, options);
        return (
          <div
            key={record.mapId}
            className="flex items-center gap-2 text-xs"
            data-testid={`portmap-cleanup-${record.mapId}`}
          >
            <span className="min-w-0 flex-1 truncate font-mono">
              {cleanupNodeName(record, options)} · {record.label}
            </span>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`portmap-cleanup-retry-${record.mapId}`}
              disabled={!retryable || busyId === record.mapId}
              title={retryable ? undefined : t('devices.portmap.cleanup.unavailable')}
              onClick={() => onRetry(record)}
            >
              {t(
                busyId === record.mapId
                  ? 'devices.portmap.cleanup.retrying'
                  : 'devices.portmap.cleanup.retry'
              )}
            </Button>
          </div>
        );
      })}
    </section>
  );
}
