// 节点表已接纳行的名字 / 状态单元格。从 nodes-table 抽出，压文件行数。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { TONE_CLASS } from '@/lib/tone';
import type { NodeRow } from '@/node/mesh-nodes';
import type { NodeView } from '@/node/node-view-model';
import { Button } from '@vibeterm/ui/button';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resolveNodePorts } from '../port-reach';
import { MetaKeyLagTag, PausedTag, PortsWarning, Tag, Td } from './row-cells';
import type { NodeUninstallController } from './types';

export interface NodeNameTagsProps {
  row: NodeRow;
}

/** 名字与它后面那串标记（当前 / 成员密钥滞后）。表格与记录卡共用。 */
export function NodeNameTags({ row }: NodeNameTagsProps) {
  const { t } = useTranslation();
  return (
    <>
      <span className="truncate font-medium">{row.name}</span>
      {row.isSelf && <Tag>{t('nodes.self')}</Tag>}
      <MetaKeyLagTag nodeId={row.id} />
    </>
  );
}

export function NameCell(props: NodeNameTagsProps) {
  return (
    <Td className="whitespace-normal">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <NodeNameTags {...props} />
        </span>
        <PortsWarning nodeId={props.row.id} ports={resolveNodePorts(props.row)} />
      </div>
    </Td>
  );
}

/**
 * 状态列：正常显示在线态；这一行正在远程卸载时改显「卸载中」，失败则显「卸载失败」并把
 * 原因放进 title，旁边留一个清除按钮——记录只活在入口这边，卸载失败后总得有办法抹掉它。
 */
export function StatusCell({
  row,
  uninstall,
  uninstalling,
  view,
}: {
  row: NodeRow;
  uninstall: NodeUninstallController;
  uninstalling: boolean;
  view: Pick<NodeView, 'statusTone' | 'statusText' | 'statusTitle'>;
}) {
  const { t } = useTranslation();
  const failed = row.operation?.kind === 'uninstall' && row.operation.phase === 'failed';

  if (uninstalling) {
    return (
      <span
        className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
        data-testid={`nodes-uninstall-state-${row.id}`}
        data-uninstall-phase={row.operation?.phase ?? 'requested'}
      >
        <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
        {t('nodes.uninstall.stateRunning')}
      </span>
    );
  }

  if (failed) {
    const clearLabel = t('nodes.uninstall.clear');
    return (
      <span className="flex items-center gap-1">
        <span
          className="text-destructive"
          title={row.operation?.error ?? undefined}
          data-testid={`nodes-uninstall-state-${row.id}`}
          data-uninstall-phase="failed"
        >
          {t('nodes.uninstall.stateFailed')}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={uninstall.clearingIds.has(row.id)}
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => uninstall.clear(row)}
          data-testid={`nodes-uninstall-clear-${row.id}`}
        >
          <X />
        </Button>
      </span>
    );
  }

  return (
    <span
      data-testid={`nodes-status-${row.id}`}
      className="inline-flex items-center gap-1.5"
      title={view.statusTitle}
    >
      <span className={TONE_CLASS.text[view.statusTone]}>{view.statusText}</span>
      {row.online && !row.loggedIn && !row.isSelf && (
        <NodeLoginButton nodeId={row.runtimeNodeId} nodeName={row.name} />
      )}
      {row.paused === true && <PausedTag />}
    </span>
  );
}
