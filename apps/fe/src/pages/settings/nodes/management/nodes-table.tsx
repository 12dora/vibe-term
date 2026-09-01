// 节点表：成员集 + 心跳合并后的一行一 node，重命名 / 吊销 / 升级动作。
// hub 不可达时重命名与吊销禁用——它们走 hub 控制面；升级只依赖入口 → 目标的 peer link，
// 因此**不**跟 hub 在线绑定，只看目标是否在线、是否已登录。
// 表格本体铺在「节点管理」卡片里，只留一层浅边框做横向滚动容器。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@tmex/ui/button';
import { Checkbox } from '@tmex/ui/checkbox';
import { Input } from '@tmex/ui/input';
import {
  Download,
  Loader2,
  Pencil,
  ShieldAlert,
  Square,
  SquareCheckBig,
  SquareMinus,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { hubDetailText, hubModeLabel } from './hub-strip';
import type { NodeActionDeps, NodeSelection, NodeUninstallController } from './types';
import { upgradeBlockReason } from './upgrade-batch';
import { useNodeRowActions } from './use-node-row-actions';
import { isUninstalling } from './use-node-uninstall';
import { isUpgradeBusy, upgradePhaseText } from './use-node-upgrade';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface NodesTableProps extends NodeActionDeps {
  rows: NodeRow[];
  selection: NodeSelection;
  uninstall: NodeUninstallController;
}

export function NodesTable({ rows, selection, uninstall, ...deps }: NodesTableProps) {
  const { t } = useTranslation();
  const allSelected =
    selection.selectableCount > 0 && selection.ids.size >= selection.selectableCount;
  const toggleLabel = t(allSelected ? 'nodes.selection.clearAll' : 'nodes.selection.selectAll');
  return (
    <section className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[54rem] text-xs" data-testid="nodes-table">
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
            <Th>{t('nodes.columns.lastSeen')}</Th>
            <Th>{t('nodes.columns.direct')}</Th>
            <Th>{t('nodes.columns.login')}</Th>
            <Th>{t('nodes.columns.fingerprint')}</Th>
            <Th>{t('nodes.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <NodeRowView
              key={row.id}
              row={row}
              selection={selection}
              uninstall={uninstall}
              {...deps}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="tmex-fade px-3 py-6 text-center text-muted-foreground">
                {t('nodes.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function deriveNodeRow(row: NodeRow, t: (key: string) => string) {
  return {
    statusClass: row.online ? 'text-emerald-500' : 'text-muted-foreground',
    statusText: t(row.online ? 'nodes.status.online' : 'nodes.status.offline'),
    reachText: row.reach ? t(`nodes.reach.${row.reach}`) : '—',
  };
}

function NodeRowView({
  row,
  selection,
  uninstall,
  ...deps
}: {
  row: NodeRow;
  selection: NodeSelection;
  uninstall: NodeUninstallController;
} & NodeActionDeps) {
  const { t } = useTranslation();
  const { renaming, setRenaming, nameDraft, setNameDraft, busy, rename, revoke } =
    useNodeRowActions(row, deps);
  const uninstalling = isUninstalling(row, uninstall.scheduledIds);
  const writable = deps.hubOnline && deps.hubWritable;
  const disabledHint = deps.hubWritable
    ? deps.hubOnline
      ? undefined
      : t('nodes.hubOffline')
    : t('nodes.hubs.standbyNotice');
  const view = deriveNodeRow(row, t);
  const selectable = !row.isSelf && !uninstalling;

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
      <Td>
        {renaming ? (
          <div className="flex items-center gap-1">
            <Input
              value={nameDraft}
              className="h-7 w-32"
              data-testid={`nodes-rename-input-${row.id}`}
              onChange={(event) => setNameDraft(event.target.value)}
            />
            <Button type="button" size="xs" disabled={busy} onClick={() => void rename()}>
              {t('nodes.rename.save')}
            </Button>
          </div>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{row.name}</span>
            {row.isSelf && <Tag>{t('nodes.self')}</Tag>}
            {row.isHub && <HubTag row={row} hubDetails={deps.hubDetails} />}
          </span>
        )}
      </Td>
      <Td>
        <StatusCell row={row} uninstall={uninstall} uninstalling={uninstalling} view={view} />
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
      </Td>
      <Td>{row.version ?? '—'}</Td>
      <Td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : '—'}</Td>
      <Td>{row.directCapable ? t('common.yes') : t('common.no')}</Td>
      <Td>
        {row.loggedIn || row.isSelf ? (
          <span className="text-emerald-500">{t('nodes.loggedIn')}</span>
        ) : (
          <NodeLoginButton nodeId={row.runtimeNodeId} nodeName={row.name} />
        )}
      </Td>
      <Td>
        <code className="font-mono text-[11px] text-muted-foreground">{row.fingerprint}</code>
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!writable || busy || uninstalling}
            title={uninstalling ? t('nodes.uninstall.busy') : disabledHint}
            onClick={() => setRenaming((value) => !value)}
            data-testid={`nodes-rename-${row.id}`}
          >
            <Pencil />
            {t('nodes.actions.rename')}
          </Button>
          {/* 卸载受理后目标随即离线，证书还挂着：这个按钮必须留着，用户刷新后能补上吊销。 */}
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={!writable || busy || row.isSelf}
            title={row.isSelf ? t('nodes.revoke.selfBlocked') : disabledHint}
            onClick={() => void revoke()}
            data-testid={`nodes-revoke-${row.id}`}
          >
            <ShieldAlert />
            {t('nodes.actions.revoke')}
          </Button>
          <UpgradeButton row={row} upgrade={deps.upgrade} blocked={uninstalling} />
          <UpgradeCancelButton row={row} upgrade={deps.upgrade} />
        </div>
      </Td>
    </tr>
  );
}

/**
 * 状态列：正常显示在线态；这一行正在远程卸载时改显「卸载中」，失败则显「卸载失败」并把
 * 原因放进 title，旁边留一个清除按钮——记录只活在入口这边，卸载失败后总得有办法抹掉它。
 */
function StatusCell({
  row,
  uninstall,
  uninstalling,
  view,
}: {
  row: NodeRow;
  uninstall: NodeUninstallController;
  uninstalling: boolean;
  view: { statusClass: string; statusText: string };
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
    <span data-testid={`nodes-status-${row.id}`} className={view.statusClass}>
      {view.statusText}
    </span>
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
  const phaseText = upgradePhaseText(t, entry.phase);

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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-3 py-2 align-middle">{children}</td>;
}

function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground"
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * hub 徽标：多 hub 下区分主 / 备并把地址、优先级、纪元、在线态放进悬浮详情；
 * 旧后端不下发 `hubMode` 时退回原来的「Hub」，单 hub 用户看不出差别。
 */
function HubTag({ row, hubDetails }: { row: NodeRow; hubDetails: NodeActionDeps['hubDetails'] }) {
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
