// 映射列表表格。行动作只有暂停 / 继续 / 删除，删除走二次确认。

import { formatBytesFixed } from '@vibeterm/api-client';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import { Pause, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DialogNodeOption } from '../dialog-nodes';
import type { PortMapRow } from './use-portmap-list';

/** 目标端点展示名：按真实 mesh id 找节点，找不到就退回短 id。 */
export function targetNodeName(row: PortMapRow, options: readonly DialogNodeOption[]): string {
  const option = options.find((item) => item.meshId === row.targetNodeId);
  return option?.name ?? row.targetNodeId.slice(0, 8);
}

function StateCell({ row }: { row: PortMapRow }) {
  const { t } = useTranslation();
  const state = row.paused ? 'paused' : row.state;
  return (
    <span className={cn('text-xs', state === 'error' && 'text-destructive')}>
      {t(`devices.portmap.state.${state}`)}
      {state === 'error' && row.error ? (
        <span className="ml-1 text-[10px]">
          {t(`devices.portmap.errors.${row.error}`, {
            defaultValue: t('devices.portmap.errors.bind_failed'),
          })}
        </span>
      ) : null}
    </span>
  );
}

export interface PortMapTableProps {
  rows: PortMapRow[];
  options: DialogNodeOption[];
  busyId: string | null;
  onToggle: (row: PortMapRow) => void;
  onDelete: (row: PortMapRow) => void;
}

export function PortMapTable({ rows, options, busyId, onToggle, onDelete }: PortMapTableProps) {
  const { t } = useTranslation();

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs" data-testid="portmap-table">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">{t('devices.portmap.columns.name')}</th>
            <th className="px-2 py-1.5 font-medium">{t('devices.portmap.columns.listen')}</th>
            <th className="px-2 py-1.5 font-medium">{t('devices.portmap.columns.target')}</th>
            <th className="px-2 py-1.5 font-medium">{t('devices.portmap.columns.state')}</th>
            <th className="px-2 py-1.5 font-medium">{t('devices.portmap.columns.connections')}</th>
            <th className="w-[15rem] min-w-[15rem] px-2 py-1.5 font-medium">
              {t('devices.portmap.columns.traffic')}
            </th>
            <th className="px-2 py-1.5 font-medium text-right">
              {t('devices.portmap.columns.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row) => (
            <tr key={`${row.nodeId}:${row.id}`} data-testid={`portmap-row-${row.id}`}>
              <td className="max-w-32 truncate px-2 py-1.5">{row.name}</td>
              <td className="px-2 py-1.5 font-mono">
                {row.nodeName}:{row.listenPort}
                {row.listenHost !== '127.0.0.1' && (
                  <span className="ml-1 text-[10px] text-muted-foreground">{row.listenHost}</span>
                )}
              </td>
              <td className="px-2 py-1.5 font-mono">
                {targetNodeName(row, options)}:{row.targetPort}
              </td>
              <td className="px-2 py-1.5">
                <StateCell row={row} />
              </td>
              <td className="px-2 py-1.5 tabular-nums">
                {row.activeConnections} / {row.totalConnections}
              </td>
              {/* 流量随连接持续增长：两个读数各自定宽，整列才不会随刷新重排。
                  列宽 15rem 按最坏情形取（两个 11ch 读数 + 方向符号 + 间距 + 左右 px-2）；
                  ↓ ↑ 对读屏无意义，方向靠同位置的 sr-only 文案交代。 */}
              <td className="w-[15rem] min-w-[15rem] px-2 py-1.5 tabular-nums">
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <span aria-hidden>↓</span>
                  <span className="sr-only">{t('common.direction.in')}</span>
                  <ByteRate data-testid={`portmap-bytes-in-${row.id}`}>
                    {formatBytesFixed(row.bytesIn)}
                  </ByteRate>
                  <span aria-hidden>·</span>
                  <span aria-hidden>↑</span>
                  <span className="sr-only">{t('common.direction.out')}</span>
                  <ByteRate data-testid={`portmap-bytes-out-${row.id}`}>
                    {formatBytesFixed(row.bytesOut)}
                  </ByteRate>
                </span>
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid={`portmap-toggle-${row.id}`}
                    aria-label={t(row.paused ? 'devices.portmap.resume' : 'devices.portmap.pause')}
                    title={t(row.paused ? 'devices.portmap.resume' : 'devices.portmap.pause')}
                    disabled={busyId === row.id}
                    onClick={() => onToggle(row)}
                  >
                    {row.paused ? (
                      <Play className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid={`portmap-delete-${row.id}`}
                    aria-label={t('devices.portmap.delete')}
                    title={t('devices.portmap.delete')}
                    disabled={busyId === row.id}
                    onClick={() => onDelete(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
