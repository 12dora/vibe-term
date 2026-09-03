// mesh 节点管理主体（设计 §4「Nodes 管理页」）。
//
// 列表 = `GET /api/mesh/nodes`（成员集权威）合并 `GET /n/<hub>/api/hub/nodes`（心跳 / 状态）。
// 动作：新增节点（enrollment）、重命名、吊销。hub 不可达时全部管理动作禁用。
//
// 整体是设置页「节点」标签里的一张卡片：卡头放刷新与「添加」，卡体依次是 hub 离线提示、
// 加入码表单、待确认列表与节点表——不再有第二层外框。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import { listPendingEnrollments, subscribePendingEnrollments } from '@/node/enrollment';
import {
  cancelPending,
  useEnrollmentEngine,
  useEnrollmentEngineState,
} from '@/node/enrollment-engine';
import { defaultRelayEnrollmentApi } from '@/node/hub-api';
import type { HubFailureReason } from '@/node/hub-load-coordinator';
import { useMeshHubs } from '@/node/mesh-hubs';
import {
  type NodeRow,
  mergeNodes,
  setEntryNodeId,
  useHubNode,
  useMeshNodes,
} from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { CircleArrowUp, Ellipsis, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { RelayConfirmDialog, RelayEnrollDialog } from '../relay/relay-dialogs';
import { UplinkSection, uplinkBlockedHint } from '../relay/uplink-section';
import { useRelayActions } from '../relay/use-relay-actions';
import { useRelayAdmitFollowUp } from '../relay/use-relay-admit-follow-up';
import { EnrollmentSection } from './enrollment-section';
import { HubRoleDialog } from './hub-role-dialog';
import { NodesTable } from './nodes-table';
import {
  type NodeSelection,
  type NodeUninstallController,
  type NodeUpgradeController,
  PLACEHOLDER_KDF,
  type ResolvedMode,
} from './types';
import { UninstallDialog } from './uninstall-dialog';
import { isBatchEligible } from './upgrade-batch';
import { useHubRoleSwitch } from './use-hub-role-switch';
import { useBulkRevoke } from './use-node-row-actions';
import { isUninstalling, useNodeUninstall } from './use-node-uninstall';
import { useNodeUpgrade } from './use-node-upgrade';

export interface NodesManagementProps {
  mode: AuthModeResponse;
  api?: AuthApi;
}

export interface HubNoticeCopy {
  testId: string;
  key: string;
  params?: Record<string, string>;
}

/**
 * hub 管理面不可用时那一行提示。hub 应答了、只是不认这次身份（通行密钥 / TOTP / 未登录）
 * 与 hub 根本打不通是两回事：前者要用户重新登录，说成「Hub 不可达」只会把人引向错误的排查。
 */
export function hubFailureNotice(failure: HubFailureReason | null): HubNoticeCopy {
  if (failure?.kind === 'auth') {
    return {
      testId: 'nodes-hub-login-rejected',
      key: 'nodes.hubLoginRejected',
      params: { code: failure.code },
    };
  }
  return { testId: 'nodes-hub-offline', key: 'nodes.hubOffline' };
}

export function NodesManagement({ mode: rawMode, api = defaultAuthApi }: NodesManagementProps) {
  const { t } = useTranslation();
  const { nodes, loading: nodesLoading, refresh: refreshNodes } = useMeshNodes();
  const entryNodeId = rawMode.nodeId || null;

  useEffect(() => {
    setEntryNodeId(entryNodeId);
  }, [entryNodeId]);

  // 兜底轮询只有 5 分钟一拍，进管理页时 store 里的列表可能已经很旧（版本号、hub 标志、
  // 登录态都只走 REST）：挂载先补一次，单飞会与常驻 owner 正在进行的那次合并。
  useEffect(() => {
    refreshNodes();
  }, [refreshNodes]);

  const hub = useHubNode(nodes, { hubNodeId: rawMode.hubNodeId ?? null });
  // hub 集合与中继链路的轮询都归本页所有：整个宿主只有节点管理页要看上级链路的全貌。
  const hubs = useMeshHubs({ owner: true });
  const relay = useMeshRelay({ owner: true });
  const rows = useMemo(
    () => mergeNodes(nodes, hub.hubNodes, { entryNodeId, hubNodeId: hub.hubNodeId }),
    [nodes, hub.hubNodes, hub.hubNodeId, entryNodeId]
  );
  const hubDetails = useMemo(() => new Map(hubs.hubs.map((row) => [row.nodeId, row])), [hubs.hubs]);

  const pendings = useSyncExternalStore(
    subscribePendingEnrollments,
    listPendingEnrollments,
    listPendingEnrollments
  );

  const hasCredentials = Boolean(rawMode.uid && rawMode.kdfParams);
  const mode: ResolvedMode | null = hasCredentials
    ? { ...rawMode, uid: rawMode.uid as string, kdfParams: rawMode.kdfParams as AuthKdfParamsJson }
    : null;

  // 管理动作可以用密码，也可以用本入口已注册的 passkey（设计 §2「用户密钥」）。
  const { passkeys } = usePasskeys(api, { enabled: hasCredentials && rawMode.passkeyAvailable });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode.rootPublicKey),
    passkeys,
    passkeyAvailable: rawMode.passkeyAvailable,
  });

  const refreshHubs = hubs.refresh;
  const refreshRelay = relay.refresh;
  // 中继链路也要跟着重拉：hub → 中继迁移之后，状态条得当场翻成中继版式，不能等下一拍轮询。
  const refreshAll = useCallback(() => {
    refreshNodes();
    hub.refresh();
    refreshHubs();
    refreshRelay();
  }, [hub, refreshHubs, refreshNodes, refreshRelay]);

  const relayActions = useRelayActions({ api, mode, prompt, onChanged: refreshAll });

  // 升级状态机独立于 enrollment / rename / revoke：它走入口 → 目标的 peer link，hub 离线也能用。
  // 传 rows 是为了刷新后能按行回读升级状态——状态只活在 React 里，页面一刷新就得重新问一遍。
  const upgrade = useNodeUpgrade(rows, refreshAll);

  // 挂在 standby 上（或一台 writer 都没有）时，管理写入会被 hub 以 `HUB_NOT_WRITER` 拒绝：
  // 先禁掉动作并给一行说明，比让用户点完再吃一条报错强。升级不走 hub 控制面，保持可用。
  // 主 hub 掉线时「hub 不可达」与这一条说的是同一件事，只留更具体的那一条。
  // 中继模式下上级不是 hub：可写与否只看有没有挂上中继，hub 的主备 / writer 一概不适用。
  const writable = relay.relayMode ? relay.writable : hub.online && !hubs.writesBlocked;
  const blockedHint = uplinkBlockedHint(t, relay.relayMode, hubs.writesBlocked);
  const hubNotice = useMemo(() => hubFailureNotice(hub.failure), [hub.failure]);

  const uninstall = useNodeUninstall(
    { api, mode, prompt, writerPublicUrl: hubs.writerPublicUrl, writable },
    refreshAll
  );
  // 主备切换与卸载共用一套「行内长事务」的观感，但它只走 hub 自己的角色接口，
  // 不经过 key log 之外的任何管理写入，因此单独一套状态。
  const roleSwitch = useHubRoleSwitch(
    {
      hubs: hubs.hubs,
      writerHubId: hubs.writerHubId,
      rows,
      api,
      mode,
      prompt,
      hubWritable: !hubs.writesBlocked,
    },
    refreshAll
  );
  const bulkRevoke = useBulkRevoke({
    api,
    mode,
    prompt,
    writerPublicUrl: hubs.writerPublicUrl,
    onChanged: refreshAll,
  });

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const selectable = useMemo(
    () => selectableRows(rows, uninstall.scheduledIds),
    [rows, uninstall.scheduledIds]
  );
  // 行消失（被移除 / 卸载中）后勾选态要跟着掉，否则批量动作会打到已经不在表里的 id 上。
  useEffect(() => {
    setSelectedIds((previous) => pruneSelection(previous, selectable));
  }, [selectable]);
  const selection: NodeSelection = useMemo(
    () => ({
      ids: selectedIds,
      selectableCount: selectable.length,
      toggle: (nodeId) => setSelectedIds((previous) => toggleSelection(previous, nodeId)),
      toggleAll: () => setSelectedIds((previous) => toggleAllSelection(previous, selectable)),
    }),
    [selectable, selectedIds]
  );
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds]
  );

  const [enrollOpen, setEnrollOpen] = useState(false);
  // 监听回路、admit 流水线与过期清理都在宿主级单例引擎里：侧滑面板同时开着时也只有一份，
  // 同一张证书绝不会被签成两条 `admit-node`（见 `enrollment-engine.ts` 顶部）。
  // 中继模式下 enrollment 建在中继上，证书也从 `/api/mesh/relay/enrollments/:id` 回读。
  const enrollChannel = relay.relayMode ? defaultRelayEnrollmentApi : hub.hubApi;
  const { confirmManually } = useEnrollmentEngine({
    api,
    mode,
    hubApi: enrollChannel,
    prompt,
    onDone: refreshAll,
    t,
  });
  const engine = useEnrollmentEngineState();
  useRelayAdmitFollowUp({
    enabled: relay.relayMode,
    admittedIds: engine.admittedIds,
    api,
    mode,
  });

  if (!mode) {
    return (
      <Card data-testid="nodes-management">
        <CardHeader>
          <CardTitle>{t('nodes.management.title')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t('auth.errors.UNKNOWN_USER')}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="nodes-management">
      <CardHeader>
        <CardTitle>{t('nodes.management.title')}</CardTitle>
        <CardAction className="flex items-center gap-1.5 self-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={refreshAll}
            aria-label={t('nodes.actions.refresh')}
            title={t('nodes.actions.refresh')}
            data-testid="nodes-refresh"
          >
            <RefreshCw
              className={
                nodesLoading || hub.loading ? 'animate-spin motion-reduce:animate-none' : undefined
              }
            />
          </Button>
          <BulkActionsMenu
            rows={selectedRows}
            selfRow={rows.find((row) => row.isSelf) ?? null}
            upgrade={upgrade}
            uninstall={uninstall}
            revoking={bulkRevoke.busy}
            onRevoke={() => void bulkRevoke.revokeRows(selectedRows)}
            writable={writable}
            blockedHint={blockedHint}
          />
          <Button
            type="button"
            size="sm"
            disabled={!writable}
            title={writable ? undefined : blockedHint}
            onClick={() => setEnrollOpen((value) => !value)}
            data-testid="nodes-add"
          >
            <Plus />
            {t('nodes.actions.add')}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <UplinkSection
          relay={relay}
          hubs={hubs}
          hubOnline={hub.online}
          hubNotice={hubNotice}
          actions={relayActions}
        />

        <EnrollmentSection
          api={api}
          mode={mode}
          hubApi={enrollChannel}
          writable={writable}
          blockedHint={blockedHint}
          writerPublicUrl={hubs.writerPublicUrl}
          open={enrollOpen}
          prompt={prompt}
          pendings={pendings}
          onConfirm={(pending) => void confirmManually(pending.hubEnrollmentId)}
          onCancel={cancelPending}
          busyIds={engine.busyIds}
          hubUnconfirmedIds={engine.hubUnconfirmedIds}
          clearedIds={engine.clearedIds}
        />

        <NodesTable
          rows={rows}
          hubApi={hub.hubApi}
          hubOnline={writable}
          hubWritable={relay.relayMode || !hubs.writesBlocked}
          blockedHint={blockedHint}
          writerPublicUrl={hubs.writerPublicUrl}
          hubDetails={hubDetails}
          mode={mode}
          api={api}
          prompt={prompt}
          onChanged={refreshAll}
          upgrade={upgrade}
          selection={selection}
          uninstall={uninstall}
          roleSwitch={roleSwitch}
        />

        <UninstallDialog uninstall={uninstall} />
        <HubRoleDialog roleSwitch={roleSwitch} />
        <RelayEnrollDialog actions={relayActions} />
        <RelayConfirmDialog actions={relayActions} />
        {prompt.dialog}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 多选
// ---------------------------------------------------------------------------

/** 可勾选的行：入口自身不能选（它自己既不能被移除也不能被卸载），正在卸载的行也锁住。 */
export function selectableRows(rows: NodeRow[], scheduledIds: ReadonlySet<string>): NodeRow[] {
  return rows.filter((row) => !row.isSelf && !isUninstalling(row, scheduledIds));
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
