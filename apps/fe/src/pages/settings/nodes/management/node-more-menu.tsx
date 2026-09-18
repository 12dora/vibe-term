// 行内「更多」：详情、内存限额、暂停 / 恢复。Base UI 菜单走 portal，列表单独导出供静态断言。

import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@vibeterm/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Ellipsis, Loader2, MemoryStick, Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { memoryLimitsSkipReason } from './node-memory-limits';
import { pauseBlockReason, pauseBlockTitle } from './pause-eligibility';
import { defaultPauseIo, useNodePause } from './use-node-pause';

export interface NodeMoreMenuListProps {
  row: Pick<NodeRow, 'id'>;
  paused: boolean;
  pauseDisabled: boolean;
  pauseTitle?: string;
  pauseBusy?: boolean;
  /** 该节点当前改不了内存限额（离线 / 未登录 / 已暂停 / 版本过旧）。 */
  memoryDisabled: boolean;
  memoryTitle?: string;
  labels: { detail: string; memory: string; pause: string };
  onDetail: () => void;
  onMemory: () => void;
  onPause: () => void;
}

export function NodeMoreMenuList({
  row,
  paused,
  pauseDisabled,
  pauseTitle,
  pauseBusy,
  memoryDisabled,
  memoryTitle,
  labels,
  onDetail,
  onMemory,
  onPause,
}: NodeMoreMenuListProps) {
  return (
    <>
      <DropdownMenuItem onClick={onDetail} data-testid={`nodes-detail-${row.id}`}>
        {labels.detail}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={memoryDisabled}
        title={memoryTitle}
        onClick={onMemory}
        data-testid={`nodes-memory-${row.id}`}
      >
        <MemoryStick className="size-4" />
        {labels.memory}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={pauseDisabled}
        title={pauseTitle}
        onClick={onPause}
        data-testid="node-pause-toggle"
        data-paused={paused ? 'true' : 'false'}
      >
        {pauseBusy ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : paused ? (
          <Play className="size-4" />
        ) : (
          <Pause className="size-4" />
        )}
        {labels.pause}
      </DropdownMenuItem>
    </>
  );
}

export function NodeMoreMenu({
  row,
  pathname,
  onChanged,
  onDetail,
  onMemory,
}: {
  row: NodeRow;
  pathname: string;
  onChanged: () => void;
  onDetail: () => void;
  onMemory: () => void;
}) {
  const { t } = useTranslation();
  const { busy, paused, toggle } = useNodePause(row, onChanged, defaultPauseIo, pathname);
  const reason = pauseBlockReason(row, pathname, paused ? 'resume' : 'pause');
  const blocked = reason !== null;
  // 暂停态以本地 toggle 的结果为准：刚点完暂停、列表还没刷新时也要立刻锁住内存限额。
  const memorySkip = memoryLimitsSkipReason({ ...row, paused });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="xs" variant="outline" data-testid={`node-more-${row.id}`} />
        }
      >
        <Ellipsis />
        {t('nodes.actions.more')}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <NodeMoreMenuList
          row={row}
          paused={paused}
          pauseDisabled={blocked || busy}
          pauseBusy={busy}
          pauseTitle={
            busy
              ? t('nodes.pause.busy')
              : blocked
                ? pauseBlockTitle(reason, t)
                : t('nodes.pause.hint')
          }
          memoryDisabled={memorySkip !== null}
          memoryTitle={
            memorySkip
              ? t('nodes.memory.unavailable', { reason: t(`nodes.memory.skip.${memorySkip}`) })
              : undefined
          }
          labels={{
            detail: t('nodes.actions.detail'),
            memory: t('nodes.actions.memory'),
            pause: t(paused ? 'nodes.actions.resume' : 'nodes.actions.pause'),
          }}
          onDetail={onDetail}
          onMemory={onMemory}
          onPause={() => void toggle()}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
