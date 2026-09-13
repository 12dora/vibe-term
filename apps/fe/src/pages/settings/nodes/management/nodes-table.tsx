// 节点表：成员集 + 心跳合并后的一行一 node，升级 / 更多（详情、暂停）/ 吊销。
// 重命名与「允许域名访问」都收进详情框（「更多」），表里不再有行内输入框。
// hub 不可达时详情里的改名与吊销禁用——它们走 hub 控制面；升级只依赖入口 → 目标的 peer link，
// 因此**不**跟 hub 在线绑定，只看目标是否在线、是否已登录。
// 表格本体铺在「节点管理」卡片里，横向滚动壳与「操作」列的钉边都在 components/wide-table。

import type { NodeRow } from '@/node/mesh-nodes';
import { buildNodeView, useMinuteClock } from '@/node/node-view-model';
import { Button } from '@vibeterm/ui/button';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { Download, Loader2, ShieldAlert, Square, SquareCheckBig, SquareMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { WideTableScroll, stickyActionColumn } from '../../components/wide-table';
import { NodeDetailDialog } from './node-detail-dialog';
import { NodeMoreMenu } from './node-more-menu';
import { NameCell, StatusCell } from './node-row-cells';
import { PendingNodeRow } from './pending-node-row';
import { RevokeDialog } from './revoke-dialog';
import { Td, Th, rowBlockedHint } from './row-cells';
import type { NodeActionDeps, NodeSelection, NodeUninstallController } from './types';
import { upgradeBlockReason } from './upgrade-batch';
import type { HubRoleSwitchController } from './use-hub-role-switch';
import { useNodeRowActions } from './use-node-row-actions';
import { isUninstalling } from './use-node-uninstall';
import { isUpgradeBusy, upgradePhaseText } from './use-node-upgrade';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface NodesTableProps extends NodeActionDeps {
  rows: NodeRow[];
  selection: NodeSelection;
  uninstall: NodeUninstallController;
  roleSwitch: HubRoleSwitchController;
}

export function NodesTable({ rows, selection, uninstall, roleSwitch, ...deps }: NodesTableProps) {
  const { t } = useTranslation();
  const pathname = useLocation().pathname;
  const allSelected =
    selection.selectableCount > 0 && selection.ids.size >= selection.selectableCount;
  const toggleLabel = t(allSelected ? 'nodes.selection.clearAll' : 'nodes.selection.selectAll');
  return (
    <WideTableScroll>
      <table className="w-full min-w-[48rem] text-xs" data-testid="nodes-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-8 px-2 py-2 text-left font-medium">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={selection.selectableCount === 0}
                aria-label={toggleLabel}
                title={toggleLabel}
                onClick={selection.toggleAll}
                data-testid="nodes-select-all"
                data-all-selected={allSelected ? 'true' : 'false'}
              >
                {allSelected ? <SquareMinus /> : <SquareCheckBig />}
              </Button>
            </th>
            <Th>{t('nodes.columns.name')}</Th>
            <Th>{t('nodes.columns.status')}</Th>
            <Th>{t('nodes.columns.reach')}</Th>
            <Th>{t('nodes.columns.version')}</Th>
            <Th>{t('nodes.columns.address')}</Th>
            <Th>{t('nodes.columns.direct')}</Th>
            <Th className={stickyActionColumn}>{t('nodes.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.pending ? (
              <PendingNodeRow key={row.id} row={row} {...deps} />
            ) : (
              <NodeRowView
                key={row.id}
                row={row}
                pathname={pathname}
                selection={selection}
                uninstall={uninstall}
                roleSwitch={roleSwitch}
                {...deps}
              />
            )
          )}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="vibeterm-fade px-3 py-6 text-center text-muted-foreground">
                {t('nodes.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function NodeRowView({
  row,
  pathname,
  selection,
  uninstall,
  roleSwitch,
  ...deps
}: {
  row: NodeRow;
  pathname: string;
  selection: NodeSelection;
  uninstall: NodeUninstallController;
  roleSwitch: HubRoleSwitchController;
} & NodeActionDeps) {
  const { t } = useTranslation();
  const { busy, rename, revoke, revokeDialog } = useNodeRowActions(row, deps);
  const [detailOpen, setDetailOpen] = useState(false);
  const uninstalling = isUninstalling(row, uninstall.scheduledIds);
  const writable = deps.hubOnline && deps.hubWritable;
  const disabledHint = writable ? undefined : rowBlockedHint(t, deps);
  const now = useMinuteClock(!row.online);
  const view = buildNodeView(row, t, now);
  const selectable = !row.isSelf && !uninstalling;
  const switching = roleSwitch.switchingIds.has(row.id);

  return (
    <tr className="border-b border-border/60 last:border-0" data-testid={`nodes-row-${row.id}`}>
      <td className="px-2 py-2 align-middle">
        <Checkbox
          checked={selection.ids.has(row.id)}
          disabled={!selectable}
          aria-label={row.name}
          title={row.isSelf ? t('nodes.selection.selfBlocked') : undefined}
          onCheckedChange={() => selection.toggle(row.id)}
          data-testid={`nodes-select-${row.id}`}
        />
      </td>
      <NameCell
        row={row}
        hubDetails={deps.hubDetails}
        roleSwitch={roleSwitch}
        rowBusy={uninstalling || isUpgradeBusy(deps.upgrade.entryOf(row.id).phase)}
      />
      <Td>
        <StatusCell
          row={row}
          uninstall={uninstall}
          uninstalling={uninstalling}
          switching={switching}
          view={view}
        />
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
      </Td>
      <Td>{row.version ?? '—'}</Td>
      <Td>
        <code
          className="block max-w-[14rem] truncate font-mono text-[11px] text-muted-foreground"
          title={view.addressText}
          data-testid={`nodes-address-${row.id}`}
        >
          {view.addressText}
        </code>
      </Td>
      <Td>{row.directCapable ? t('common.yes') : t('common.no')}</Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-center gap-1">
          <UpgradeButton row={row} upgrade={deps.upgrade} blocked={uninstalling} />
          <UpgradeCancelButton row={row} upgrade={deps.upgrade} />
          {/* 详情里既有只读信息也有节点本地的域名访问策略，hub 不可写时照样能开。 */}
          <NodeMoreMenu
            row={row}
            pathname={pathname}
            onChanged={deps.onChanged}
            onDetail={() => setDetailOpen(true)}
          />
          {/* 卸载受理后目标随即离线，证书还挂着：这个按钮必须留着，用户刷新后能补上吊销。 */}
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={!writable || busy || row.isSelf}
            title={row.isSelf ? t('nodes.revoke.selfBlocked') : disabledHint}
            onClick={revoke}
            data-testid={`nodes-revoke-${row.id}`}
          >
            <ShieldAlert />
            {t('nodes.actions.revoke')}
          </Button>
        </div>
        <RevokeDialog controller={revokeDialog} />
        {detailOpen && (
          <NodeDetailDialog
            row={row}
            open
            onOpenChange={setDetailOpen}
            renameAvailable={writable && !uninstalling}
            writerPublicUrl={deps.writerPublicUrl}
            rename={rename}
            onChanged={deps.onChanged}
          />
        )}
      </Td>
    </tr>
  );
}

/**
 * 升级按钮：目标离线、（远端）未登录、版本过旧无法远程升级、已是最新时禁用并说明原因；
 * 进行中显示阶段文案并锁住，批量升级期间整列一并锁住，避免同一节点被点两次。
 * 刷新后回读这一行的升级状态期间同样锁住——不知道目标在不在升级时点下去只会撞上
 * `UPGRADE_IN_PROGRESS`，还会把随后接手的 watcher 挤掉。
 * 本机同样可以升级——它会重启本机网关，当前访问随之中断，确认框里已经写明。
 */
function UpgradeButton({
  row,
  upgrade,
  blocked: uninstalling,
}: { row: NodeRow; upgrade: NodeActionDeps['upgrade']; blocked: boolean }) {
  const { t } = useTranslation();
  const entry = upgrade.entryOf(row.id);
  const busy = isUpgradeBusy(entry.phase);
  const restoring = upgrade.restoringIds.has(row.id);
  const blocked = uninstalling
    ? t('nodes.uninstall.busy')
    : upgradeBlockedHint(row, upgrade.latest?.latestVersion ?? null, t);
  const version = entry.targetVersion ?? upgrade.latest?.latestVersion ?? null;
  const phaseText = upgradePhaseText(t, entry.phase, entry.transfer);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={busy || blocked !== null || upgrade.batch.running || restoring}
      title={
        restoring
          ? t('nodes.upgrade.restoring')
          : (blocked ?? upgradeTitle(entry.error, version, t))
      }
      onClick={() => upgrade.start(row)}
      data-testid={`node-upgrade-${row.id}`}
      data-upgrade-phase={entry.phase}
    >
      {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Download />}
      {phaseText ?? t('nodes.upgrade.action')}
    </Button>
  );
}

/**
 * 「停止升级」：只在这一行有升级在跑时出现。下载阶段（含刚发出请求的 `pending`）可以打断；
 * 进到安装 / 重启就只剩一个禁用的按钮说明原因——半路掐掉安装会留下一台装坏的机器。
 * 停止请求在途时按钮转圈并锁住，连点不会发出第二条 DELETE。
 */
function UpgradeCancelButton({
  row,
  upgrade,
}: { row: NodeRow; upgrade: NodeActionDeps['upgrade'] }) {
  const { t } = useTranslation();
  const { phase, cancelling } = upgrade.entryOf(row.id);
  if (!isUpgradeBusy(phase)) return null;
  const interruptible = phase === 'pending' || phase === 'downloading';
  const title = t(cancelKey(interruptible, cancelling));

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="outline"
      disabled={!interruptible || cancelling}
      title={title}
      aria-label={title}
      onClick={() => upgrade.cancel(row)}
      data-testid={`node-upgrade-cancel-${row.id}`}
    >
      {cancelling ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Square />}
    </Button>
  );
}

function cancelKey(interruptible: boolean, cancelling: boolean): string {
  if (cancelling) return 'nodes.upgrade.cancelling';
  return interruptible ? 'nodes.upgrade.cancel' : 'nodes.upgrade.cancelNotAllowed';
}

export function upgradeBlockedHint(
  row: NodeRow,
  latestVersion: string | null,
  t: Translate
): string | null {
  const reason = upgradeBlockReason(row, latestVersion);
  if (!reason) return null;
  if (reason === 'tooOld') return t('nodes.upgrade.tooOld', { version: row.version ?? '' });
  return t(`nodes.upgrade.${reason}`);
}

function upgradeTitle(
  error: string | null,
  version: string | null,
  t: Translate
): string | undefined {
  if (error) return error;
  return version ? t('nodes.upgrade.hint', { version }) : undefined;
}
