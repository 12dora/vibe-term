// 节点表的多选与卡头「更多」：批量升级 / 移除 / 卸载。
//
// 三个菜单项的可点性各自成一份纯函数（`bulkMenuStates`），单测直接对它断言；
// Base UI 的菜单走 portal，静态渲染什么都不输出，因此下拉内容也单独导出成不带 hook 的组件。

import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { CircleArrowUp, Ellipsis, ShieldAlert, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeUninstallController, NodeUpgradeController } from './types';
import { isBatchEligible } from './upgrade-batch';
import { isUninstalling } from './use-node-uninstall';

/** 可勾选的行：入口自身不能选（它自己既不能被移除也不能被卸载），正在卸载的行也锁住。 */
export function selectableRows(rows: NodeRow[], scheduledIds: ReadonlySet<string>): NodeRow[] {
  // 待批准行还不是成员：升级 / 移除 / 卸载都打不到它，勾选只会让批量动作凭空多出失败项。
  return rows.filter(
    (row) => !row.isSelf && row.pending !== true && !isUninstalling(row, scheduledIds)
  );
}

export function toggleSelection(ids: ReadonlySet<string>, nodeId: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (!next.delete(nodeId)) next.add(nodeId);
  return next;
}

/** 全选 / 全不选合成一个动作：没全选就全选，已全选就清空。 */
export function toggleAllSelection(
  ids: ReadonlySet<string>,
  selectable: NodeRow[]
): ReadonlySet<string> {
  const all = selectable.every((row) => ids.has(row.id));
  return all ? new Set<string>() : new Set(selectable.map((row) => row.id));
}

/** 摘掉已经不可选的 id；没有变化时返回原引用，避免白白重渲染。 */
export function pruneSelection(
  ids: ReadonlySet<string>,
  selectable: NodeRow[]
): ReadonlySet<string> {
  const alive = new Set(selectable.map((row) => row.id));
  const next = new Set([...ids].filter((id) => alive.has(id)));
  return next.size === ids.size ? ids : next;
}

// ---------------------------------------------------------------------------
// 卡头「更多」
// ---------------------------------------------------------------------------

export interface BulkItemState {
  disabled: boolean;
  /** 禁用原因；可点时为 `undefined`。 */
  title?: string;
}

export interface BulkMenuInput {
  selectedCount: number;
  /** 这次批量真能升级的台数（含被追加进来的本机）。 */
  eligibleUpgradeCount: number;
  /** 本机会跟着这一批一起升级：升到最后一步时当前页面会断一下。 */
  selfIncluded: boolean;
  latestKnown: boolean;
  /** 已有升级在跑（行内或批量）。 */
  upgradeBusy: boolean;
  /** 刷新后正在回读各节点升级状态。 */
  restoring: boolean;
  /** hub 当前接受管理写入。 */
  writable: boolean;
  blockedHint: string;
  uninstallRunning: boolean;
  revoking: boolean;
}

/**
 * 三个菜单项的可点性与禁用原因。共同的前置条件是「选中了东西」与「没有别的批量在跑」，
 * 各自再叠自己的条件：升级看 latest 与可升级台数，移除与卸载都要 hub 收得下写入。
 */
export function bulkMenuStates(
  input: BulkMenuInput,
  t: (key: string, options?: Record<string, unknown>) => string
): { upgrade: BulkItemState; revoke: BulkItemState; uninstall: BulkItemState } {
  const empty: BulkItemState = { disabled: true, title: t('nodes.selection.none') };
  const busyHint = input.uninstallRunning
    ? t('nodes.uninstall.running')
    : input.revoking
      ? t('nodes.selection.busy')
      : input.restoring
        ? t('nodes.upgrade.restoring')
        : t('nodes.upgrade.allBusy');
  const busy: BulkItemState = { disabled: true, title: busyHint };
  const anyBusy = input.upgradeBusy || input.restoring || input.uninstallRunning || input.revoking;

  const upgrade = (): BulkItemState => {
    if (input.selectedCount === 0) return empty;
    if (anyBusy) return busy;
    if (!input.latestKnown) return { disabled: true, title: t('nodes.upgrade.releaseUnavailable') };
    if (input.eligibleUpgradeCount === 0)
      return { disabled: true, title: t('nodes.upgrade.allNone') };
    if (!input.selfIncluded) return { disabled: false };
    return { disabled: false, title: t('nodes.selection.upgradeSelfNotice') };
  };

  const revoke = (): BulkItemState => {
    if (input.selectedCount === 0) return empty;
    if (!input.writable) return { disabled: true, title: input.blockedHint };
    if (anyBusy) return busy;
    return { disabled: false };
  };

  const uninstall = (): BulkItemState => {
    if (input.selectedCount === 0) return empty;
    // 卸载以一次签名 `revoke-node` 收尾：hub 不收写入时机器会被删干净，证书却撤不掉。
    if (!input.writable) return { disabled: true, title: input.blockedHint };
    if (anyBusy) return busy;
    return { disabled: false };
  };

  return { upgrade: upgrade(), revoke: revoke(), uninstall: uninstall() };
}

export interface BulkActionsMenuListProps {
  states: ReturnType<typeof bulkMenuStates>;
  labels: { upgrade: string; revoke: string; uninstall: string };
  onUpgrade: () => void;
  onRevoke: () => void;
  onUninstall: () => void;
}

/**
 * 下拉内容。单独导出且不自带 hook：Base UI 的菜单走 portal，静态渲染什么都不输出，
 * 单测只能直接对元素树做断言（与 `AddDeviceMenuList` 同一套做法）。
 */
export function BulkActionsMenuList({
  states,
  labels,
  onUpgrade,
  onRevoke,
  onUninstall,
}: BulkActionsMenuListProps) {
  return (
    <>
      <DropdownMenuItem
        disabled={states.upgrade.disabled}
        title={states.upgrade.title}
        onClick={onUpgrade}
        data-testid="nodes-bulk-upgrade"
      >
        <CircleArrowUp className="size-4" />
        {labels.upgrade}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={states.revoke.disabled}
        title={states.revoke.title}
        onClick={onRevoke}
        data-testid="nodes-bulk-revoke"
      >
        <ShieldAlert className="size-4" />
        {labels.revoke}
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        disabled={states.uninstall.disabled}
        title={states.uninstall.title}
        onClick={onUninstall}
        data-testid="nodes-bulk-uninstall"
      >
        <Trash2 className="size-4" />
        {labels.uninstall}
      </DropdownMenuItem>
    </>
  );
}

/**
 * 批量升级的实际目标：勾选的行**再加上本机**。本机那一行不可勾选（移除 / 卸载都轮不到它），
 * 但升级必须带得上它——持久化的「普通节点 → hub → 本机」次序与入口重启后的续跑，只有本机
 * 真的进了批量才走得到。一个都没勾时不追加：菜单仍然停在「须先勾选节点」。
 */
export function bulkUpgradeTargets(
  selected: NodeRow[],
  selfRow: NodeRow | null,
  latestVersion: string | null
): { rows: NodeRow[]; selfIncluded: boolean } {
  if (selected.length === 0 || !selfRow) return { rows: selected, selfIncluded: false };
  // 用批量自己的那把尺子（`upgradeBlockReason` 为空 + 版本可解析且低于 latest）：
  // 换一把更松的只会让标签写着「含本机」而 `launchUpgradeBatch` 转头把它筛掉。
  if (!isBatchEligible(selfRow, latestVersion)) return { rows: selected, selfIncluded: false };
  return { rows: [...selected, selfRow], selfIncluded: true };
}

/**
 * 「更多」：对**选中的行**批量升级 / 移除 / 卸载。没有单独的「全部升级」了——
 * 全选再走这个菜单即可，两个入口做同一件事只会让人猜它们有什么区别。
 * 升级是唯一会自动带上本机的动作，标签里写明「含本机」。
 */
export function BulkActionsMenu({
  rows,
  selfRow,
  upgrade,
  uninstall,
  revoking,
  onRevoke,
  writable,
  blockedHint,
}: {
  rows: NodeRow[];
  selfRow: NodeRow | null;
  upgrade: NodeUpgradeController;
  uninstall: NodeUninstallController;
  revoking: boolean;
  onRevoke: () => void;
  writable: boolean;
  blockedHint: string;
}) {
  const { t } = useTranslation();
  const latestVersion = upgrade.latest?.latestVersion ?? null;
  const targets = bulkUpgradeTargets(rows, selfRow, latestVersion);
  const upgradeCount = upgrade.eligibleCount(targets.rows);
  const states = bulkMenuStates(
    {
      selectedCount: rows.length,
      eligibleUpgradeCount: upgradeCount,
      selfIncluded: targets.selfIncluded,
      latestKnown: Boolean(latestVersion),
      upgradeBusy: upgrade.anyRunning || upgrade.batch.running,
      restoring: upgrade.restoring,
      writable,
      blockedHint,
      uninstallRunning: uninstall.running,
      revoking,
    },
    t
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('nodes.selection.more')}
            title={t('nodes.selection.more')}
            data-testid="nodes-bulk-menu"
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <BulkActionsMenuList
          states={states}
          labels={{
            upgrade: t(
              targets.selfIncluded ? 'nodes.selection.upgradeWithSelf' : 'nodes.selection.upgrade',
              { count: upgradeCount }
            ),
            revoke: t('nodes.selection.revoke'),
            uninstall: t('nodes.selection.uninstall'),
          }}
          onUpgrade={() => upgrade.startAll(targets.rows)}
          onRevoke={onRevoke}
          onUninstall={() => uninstall.request(rows)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
