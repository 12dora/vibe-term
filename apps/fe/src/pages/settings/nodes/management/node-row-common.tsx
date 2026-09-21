// 节点行的共用件：一行的状态（`useNodeRowShared`）、升级 / 停止 / 吊销三个按钮，以及两个对话框。
// 宽屏表格行（nodes-table）与窄屏记录卡（nodes-card-list）都从这里取，两套版式只是摆法不同，
// 动作与状态必须完全一致。

import { useNodeLoginFailure } from '@/auth/node-login-retry';
import type { NodeRow } from '@/node/mesh-nodes';
import { useNodeRequestBlocked } from '@/node/node-unreachable-backoff';
import { type NodeView, buildNodeView, useMinuteClock } from '@/node/node-view-model';
import { Button } from '@vibeterm/ui/button';
import { Download, Loader2, ShieldAlert, Square, SquareCheckBig, SquareMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeDetailDialog } from './node-detail-dialog';
import { NodeMemoryDialog } from './node-memory-dialog';
import { RevokeDialog } from './revoke-dialog';
import { rowBlockedHint } from './row-cells';
import type {
  NodeActionDeps,
  NodeSelection,
  NodeUninstallController,
  RevokeController,
} from './types';
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

/** 全选按钮：未全选时全选，已全选时清空。表头与记录卡卡头共用。 */
export function SelectAllButton({ selection }: { selection: NodeSelection }) {
  const { t } = useTranslation();
  const allSelected =
    selection.selectableCount > 0 && selection.ids.size >= selection.selectableCount;
  const label = t(allSelected ? 'nodes.selection.clearAll' : 'nodes.selection.selectAll');
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      disabled={selection.selectableCount === 0}
      aria-label={label}
      title={label}
      onClick={selection.toggleAll}
      data-testid="nodes-select-all"
      data-all-selected={allSelected ? 'true' : 'false'}
    >
      {allSelected ? <SquareMinus /> : <SquareCheckBig />}
    </Button>
  );
}

export interface NodeRowShared {
  busy: boolean;
  rename: (name: string) => Promise<void>;
  revoke: () => void;
  revokeDialog: RevokeController;
  detailOpen: boolean;
  setDetailOpen: (open: boolean) => void;
  /** 「内存限额」对话框是否打开。 */
  memoryOpen: boolean;
  setMemoryOpen: (open: boolean) => void;
  /** 这一行正在远程卸载。 */
  uninstalling: boolean;
  /** 上级链路当前收得下管理写入。 */
  writable: boolean;
  /** 不可写时的原因；可写时为 `undefined`。 */
  disabledHint?: string;
  view: NodeView;
  /** 可勾选（非本机、没在卸载）。 */
  selectable: boolean;
}

export function useNodeRowShared(
  row: NodeRow,
  deps: NodeActionDeps,
  uninstall: NodeUninstallController
): NodeRowShared {
  const { t } = useTranslation();
  const { busy, rename, revoke, revokeDialog } = useNodeRowActions(row, deps);
  const [detailOpen, setDetailOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const uninstalling = isUninstalling(row, uninstall.scheduledIds);
  const writable = deps.uplinkWritable;
  const now = useMinuteClock(!row.online);
  // 表格自己不发登录请求：链路事实来自别处记下的登录失败与每 node 的 REST 退避，
  // 否则一次链路抖动在这张表上只会写成「在线 · 未登录」，再配一个点了也没用的登录按钮。
  const loginFailure = useNodeLoginFailure(row.runtimeNodeId);
  const unreachable = useNodeRequestBlocked(row.runtimeNodeId);

  return {
    busy,
    rename,
    revoke,
    revokeDialog,
    detailOpen,
    setDetailOpen,
    memoryOpen,
    setMemoryOpen,
    uninstalling,
    writable,
    disabledHint: writable ? undefined : rowBlockedHint(t, deps),
    view: buildNodeView(row, t, now, {
      failureCode: loginFailure?.code ?? null,
      unreachable,
      retrying: loginFailure?.retrying ?? false,
    }),
    selectable: !row.isSelf && !uninstalling,
  };
}

/** 吊销确认框 + 详情框 + 内存限额框。两套版式都要挂，且同一行只能有一份。 */
export function NodeRowDialogs({
  row,
  shared,
  deps,
}: { row: NodeRow; shared: NodeRowShared; deps: NodeActionDeps }) {
  return (
    <>
      <RevokeDialog controller={shared.revokeDialog} />
      {shared.detailOpen && (
        <NodeDetailDialog
          row={row}
          open
          onOpenChange={shared.setDetailOpen}
          renameAvailable={shared.writable && !shared.uninstalling}
          rename={shared.rename}
          onChanged={deps.onChanged}
        />
      )}
      {/* 关掉就卸载：下次打开必须重新 GET 目标节点当前的限额，而不是接着看上一次的草稿。 */}
      {shared.memoryOpen && <NodeMemoryDialog row={row} open onOpenChange={shared.setMemoryOpen} />}
    </>
  );
}

/** 卸载受理后目标随即离线，证书还挂着：这个按钮必须留着，用户刷新后能补上吊销。 */
export function RevokeButton({
  row,
  shared,
}: { row: NodeRow; shared: Pick<NodeRowShared, 'writable' | 'busy' | 'disabledHint' | 'revoke'> }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      size="xs"
      variant="destructive"
      disabled={!shared.writable || shared.busy || row.isSelf}
      title={row.isSelf ? t('nodes.revoke.selfBlocked') : shared.disabledHint}
      onClick={shared.revoke}
      data-testid={`nodes-revoke-${row.id}`}
    >
      <ShieldAlert />
      {t('nodes.actions.revoke')}
    </Button>
  );
}

/**
 * 升级按钮：目标离线、（远端）未登录、版本过旧无法远程升级、已是最新时禁用并说明原因；
 * 进行中显示阶段文案并锁住，批量升级期间整列一并锁住，避免同一节点被点两次。
 * 刷新后回读这一行的升级状态期间同样锁住——不知道目标在不在升级时点下去只会撞上
 * `UPGRADE_IN_PROGRESS`，还会把随后接手的 watcher 挤掉。
 * 本机同样可以升级——它会重启本机网关，当前访问随之中断，确认框里已经写明。
 */
export function UpgradeButton({
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
export function UpgradeCancelButton({
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
