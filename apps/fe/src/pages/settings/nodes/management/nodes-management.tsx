// mesh 节点管理主体（设计 §4「Nodes 管理页」）。
//
// 列表 = `GET /api/mesh/nodes`（成员集权威）加上 `pendingMemberIds` 占位行。
// 动作：新增节点（中继 enrollment）、重命名、吊销。未挂中继时加入码不可用。
//
// 整体是设置页「节点」标签里的一张卡片：卡头放刷新与「添加」，卡体依次是加入码表单、
// 待确认列表与节点表。上级链路与它的操作都在本机卡上，这里只读它的状态。

import { listPendingEnrollments, subscribePendingEnrollments } from '@/node/enrollment';
import { defaultRelayEnrollmentApi } from '@/node/enrollment-api';
import {
  cancelPending,
  useEnrollmentEngine,
  useEnrollmentEngineState,
} from '@/node/enrollment-engine';
import { mergeNodes, setEntryNodeId, useMeshNodes } from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { Button } from '@vibeterm/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { RelayMetaLagNotice } from '../relay/relay-meta-lag-notice';
import { useRelayAdmitFollowUp } from '../relay/use-relay-admit-follow-up';
import type { LocalUplinkController } from '../uplink/local-uplink-controller';
import { uplinkBlockedHint } from '../uplink/relay-targets';
import {
  BulkActionsMenu,
  pruneSelection,
  selectableRows,
  toggleAllSelection,
  toggleSelection,
} from './bulk-actions-menu';
import { EnrollmentSection } from './enrollment-section';
import { NodesSyncGate } from './nodes-sync-gate';
import { NodesTable } from './nodes-table';
import { RevokeDialog } from './revoke-dialog';
import type { NodeSelection, ResolvedMode } from './types';
import { UninstallDialog } from './uninstall-dialog';
import { UpgradeConfirmDialog } from './upgrade-confirm-dialog';
import { useBulkRevoke } from './use-node-row-actions';
import { useNodeUninstall } from './use-node-uninstall';
import { useNodeUpgrade } from './use-node-upgrade-controller';

/** 上级链路的只读视图：本页不再自己轮询中继，一律取本机卡建好的那一份。 */
export type NodesManagementUplink = Pick<LocalUplinkController, 'relay' | 'prompt' | 'refreshAll'>;

export interface NodesManagementProps {
  mode: AuthModeResponse;
  uplink: NodesManagementUplink;
  api?: AuthApi;
}

export function NodesManagement({
  mode: rawMode,
  uplink,
  api = defaultAuthApi,
}: NodesManagementProps) {
  const { t } = useTranslation();
  const { nodes, pendingMemberIds, loading: nodesLoading, refresh: refreshNodes } = useMeshNodes();
  const entryNodeId = rawMode.nodeId || null;

  useEffect(() => {
    setEntryNodeId(entryNodeId);
  }, [entryNodeId]);

  // 兜底轮询只有 5 分钟一拍，进管理页时 store 里的列表可能已经很旧（版本号、
  // 登录态都只走 REST）：挂载先补一次，单飞会与常驻 owner 正在进行的那次合并。
  useEffect(() => {
    refreshNodes();
  }, [refreshNodes]);

  const { relay, prompt } = uplink;
  const rows = useMemo(
    () => mergeNodes(nodes, { entryNodeId, pendingMemberIds }),
    [nodes, entryNodeId, pendingMemberIds]
  );

  const pendings = useSyncExternalStore(
    subscribePendingEnrollments,
    listPendingEnrollments,
    listPendingEnrollments
  );

  const hasCredentials = Boolean(rawMode.uid && rawMode.kdfParams);
  const mode: ResolvedMode | null = hasCredentials
    ? { ...rawMode, uid: rawMode.uid as string, kdfParams: rawMode.kdfParams as AuthKdfParamsJson }
    : null;

  const refreshAll = uplink.refreshAll;

  // 升级状态机独立于 enrollment / rename / revoke：它走入口 → 目标的 peer link。
  // 传 rows 是为了刷新后能按行回读升级状态——状态只活在 React 里，页面一刷新就得重新问一遍。
  const upgrade = useNodeUpgrade(rows, refreshAll);

  const writable = relay.writable;
  const enrollWritable = relay.relayMode && writable;
  const blockedHint = uplinkBlockedHint(t, relay.relayMode);

  const uninstall = useNodeUninstall({ api, mode, prompt, writable }, refreshAll);
  const bulkRevoke = useBulkRevoke({
    api,
    mode,
    prompt,
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
  // enrollment 建在中继上，证书也从 `/api/mesh/relay/enrollments/:id` 回读。
  const enrollChannel = defaultRelayEnrollmentApi;
  const { confirmManually } = useEnrollmentEngine({
    api,
    mode,
    enrollmentApi: enrollChannel,
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
              className={nodesLoading ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
          </Button>
          <BulkActionsMenu
            rows={selectedRows}
            selfRow={rows.find((row) => row.isSelf) ?? null}
            upgrade={upgrade}
            uninstall={uninstall}
            revoking={bulkRevoke.busy}
            onRevoke={() => bulkRevoke.revokeRows(selectedRows)}
            onChanged={refreshAll}
            writable={writable}
            blockedHint={blockedHint}
          />
          <Button
            type="button"
            size="sm"
            disabled={!enrollWritable}
            title={enrollWritable ? undefined : blockedHint}
            onClick={() => setEnrollOpen((value) => !value)}
            data-testid="nodes-add"
          >
            <Plus />
            {t('nodes.actions.add')}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {/* 成员密钥没送到的成员：服务端真相，与本标签页记了什么无关（见 relay-meta-lag-notice.tsx）。 */}
        <RelayMetaLagNotice
          lagging={relay.metaKeyLagging}
          mode={mode}
          api={api}
          prompt={prompt}
          onChanged={refreshAll}
        />
        <EnrollmentSection
          api={api}
          mode={mode}
          relay={relay}
          writable={enrollWritable}
          blockedHint={blockedHint}
          open={enrollOpen}
          prompt={prompt}
          pendings={pendings}
          onConfirm={(pending) => void confirmManually(pending.hubEnrollmentId)}
          onCancel={cancelPending}
          busyIds={engine.busyIds}
          unconfirmedIds={engine.hubUnconfirmedIds}
          clearedIds={engine.clearedIds}
        />

        <NodesSyncGate>
          <NodesTable
            rows={rows}
            enrollmentApi={enrollChannel}
            uplinkWritable={writable}
            blockedHint={blockedHint}
            mode={mode}
            api={api}
            prompt={prompt}
            onChanged={refreshAll}
            upgrade={upgrade}
            selection={selection}
            uninstall={uninstall}
          />
        </NodesSyncGate>

        <UninstallDialog uninstall={uninstall} />
        <UpgradeConfirmDialog upgrade={upgrade} />
        <RevokeDialog controller={bulkRevoke.revokeDialog} />
      </CardContent>
    </Card>
  );
}
