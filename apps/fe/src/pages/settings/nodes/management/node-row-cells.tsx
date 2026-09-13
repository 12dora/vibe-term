// 节点表已接纳行的名字 / 状态单元格。从 nodes-table 抽出，压文件行数。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { TONE_CLASS } from '@/lib/tone';
import type { NodeRow } from '@/node/mesh-nodes';
import type { NodeView } from '@/node/node-view-model';
import { Button } from '@vibeterm/ui/button';
import { ArrowLeftRight, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { resolveNodePorts } from '../port-reach';
import { hubDetailText, hubModeLabel } from '../uplink/hub-strip';
import { MetaKeyLagTag, PausedTag, PortsWarning, Tag, Td } from './row-cells';
import type { NodeActionDeps, NodeUninstallController } from './types';
import type { HubRoleSwitchController } from './use-hub-role-switch';
import { hubRoleBlockedText } from './use-hub-role-switch';

export function NameCell({
  row,
  hubDetails,
  roleSwitch,
  rowBusy,
}: {
  row: NodeRow;
  hubDetails: NodeActionDeps['hubDetails'];
  roleSwitch: HubRoleSwitchController;
  rowBusy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Td className="whitespace-normal">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="truncate font-medium">{row.name}</span>
          {row.isSelf && <Tag>{t('nodes.self')}</Tag>}
          <MetaKeyLagTag nodeId={row.id} />
          {row.isHub && (
            <>
              <HubTag row={row} hubDetails={hubDetails} />
              <HubRoleSwitchButton row={row} roleSwitch={roleSwitch} rowBusy={rowBusy} />
            </>
          )}
        </span>
        <PortsWarning nodeId={row.id} ports={resolveNodePorts(row)} />
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
  switching,
  view,
}: {
  row: NodeRow;
  uninstall: NodeUninstallController;
  uninstalling: boolean;
  switching: boolean;
  view: Pick<NodeView, 'statusTone' | 'statusText' | 'statusTitle'>;
}) {
  const { t } = useTranslation();
  const failed = row.operation?.kind === 'uninstall' && row.operation.phase === 'failed';

  // 主备切换只活在这一个页面里（服务端不下发 `role-switch` 记录），因此这一档排在最前：
  // 目标机重启期间它同时是「离线」，照原样显示只会让人以为切换把机器弄挂了。
  if (switching) {
    return (
      <span
        className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
        data-testid={`nodes-role-switch-state-${row.id}`}
      >
        <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
        {t('nodes.hubs.role.stateSwitching')}
      </span>
    );
  }

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

/**
 * Hub 主备切换：备 Hub 上写「设为主 Hub」，当前写者上写「设为备 Hub」。
 * 离线、旧后端不下发授权来源、已有切换在跑、这一行正在升级 / 卸载、以及「须先签授权但 hub
 * 不收写入」都禁用并把原因放进 title——这个按钮会重启目标机，绝不能让人在不确定的前提下点。
 */
export function HubRoleSwitchButton({
  row,
  roleSwitch,
  rowBusy,
}: { row: NodeRow; roleSwitch: HubRoleSwitchController; rowBusy: boolean }) {
  const { t } = useTranslation();
  const state = roleSwitch.stateOf(row, rowBusy);
  const label = t(
    state.intent === 'promote' ? 'nodes.hubs.role.promote' : 'nodes.hubs.role.demote'
  );
  const title = state.blocked ? hubRoleBlockedText(t, state.blocked) : label;

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      disabled={state.blocked !== null}
      aria-label={label}
      title={title}
      onClick={() => roleSwitch.request(row)}
      data-testid={`nodes-hub-role-${row.id}`}
      data-role-intent={state.intent}
    >
      <ArrowLeftRight />
    </Button>
  );
}

/**
 * hub 徽标：多 hub 下区分主 / 备并把地址、优先级、纪元、在线态放进悬浮详情；
 * 旧后端不下发 `hubMode` 时退回原来的「Hub」，单 hub 用户看不出差别。
 */
export function HubTag({
  row,
  hubDetails,
}: { row: NodeRow; hubDetails: NodeActionDeps['hubDetails'] }) {
  const { t } = useTranslation();
  const detail = hubDetails.get(row.id);
  return (
    <Tag title={detail ? hubDetailText(t, detail, false) : undefined}>
      <span data-testid={`nodes-hub-tag-${row.id}`} data-hub-mode={row.hubMode ?? ''}>
        {hubModeLabel(t, row.hubMode ?? null)}
      </span>
    </Tag>
  );
}
