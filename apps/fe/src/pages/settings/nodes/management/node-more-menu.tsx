// 行内「更多」：详情、暂停 / 恢复。Base UI 菜单走 portal，列表单独导出供静态断言。

import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@vibeterm/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Ellipsis, Loader2, Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { pauseBlockReason, pauseBlockTitle } from './pause-eligibility';
import { useNodePause } from './use-node-pause';

export interface NodeMoreMenuListProps {
  row: Pick<NodeRow, 'id'>;
  paused: boolean;
  pauseDisabled: boolean;
  pauseTitle?: string;
  pauseBusy?: boolean;
  labels: { detail: string; pause: string };
  onDetail: () => void;
  onPause: () => void;
}

export function NodeMoreMenuList({
  row,
  paused,
  pauseDisabled,
  pauseTitle,
  pauseBusy,
  labels,
  onDetail,
  onPause,
}: NodeMoreMenuListProps) {
  return (
    <>
      <DropdownMenuItem onClick={onDetail} data-testid={`nodes-detail-${row.id}`}>
        {labels.detail}
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
}: {
  row: NodeRow;
  pathname: string;
  onChanged: () => void;
  onDetail: () => void;
}) {
  const { t } = useTranslation();
  const { busy, paused, toggle } = useNodePause(row, onChanged);
  const reason = pauseBlockReason(row, pathname);
  const blocked = reason !== null;
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
          pauseTitle={blocked ? pauseBlockTitle(reason, t) : t('nodes.pause.hint')}
          labels={{
            detail: t('nodes.actions.detail'),
            pause: t(paused ? 'nodes.actions.resume' : 'nodes.actions.pause'),
          }}
          onDetail={onDetail}
          onPause={() => void toggle()}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
