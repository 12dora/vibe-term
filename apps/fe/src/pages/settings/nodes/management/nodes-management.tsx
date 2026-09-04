// mesh 节点管理主体（设计 §4「Nodes 管理页」）。
//
// 列表 = `GET /api/mesh/nodes`（成员集权威）合并 `GET /n/<hub>/api/hub/nodes`（心跳 / 状态）。
// 动作：新增节点（enrollment）、重命名、吊销。hub 不可达时全部管理动作禁用。
//
// 整体是设置页「节点」标签里的一张卡片：卡头放刷新与「添加」，卡体依次是加入码表单、
// 待确认列表与节点表。上级链路（接 Hub 还是接中继）与它的操作都在本机卡上，这里只读它的状态。

import { listPendingEnrollments, subscribePendingEnrollments } from '@/node/enrollment';
import {
  cancelPending,
  useEnrollmentEngine,
  useEnrollmentEngineState,
} from '@/node/enrollment-engine';
import { defaultRelayEnrollmentApi } from '@/node/hub-api';
import { mergeNodes, setEntryNodeId, useMeshNodes } from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
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
import { HubRoleDialog } from './hub-role-dialog';
import { NodesTable } from './nodes-table';
import type { NodeSelection, ResolvedMode } from './types';
import { UninstallDialog } from './uninstall-dialog';
import { useHubRoleSwitch } from './use-hub-role-switch';
import { useBulkRevoke } from './use-node-row-actions';
import { useNodeUninstall } from './use-node-uninstall';
import { useNodeUpgrade } from './use-node-upgrade';

/** 上级链路的只读视图：本页不再自己轮询 hub 集合与中继，一律取本机卡建好的那一份。 */
export type NodesManagementUplink = Pick<
  LocalUplinkController,
  'hubs' | 'hub' | 'relay' | 'prompt' | 'refreshAll'
>;

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

  const { hub, hubs, relay, prompt } = uplink;
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

  // 节点列表 + hub 管理面 + hub 集合 + 中继链路一起重拉，由上级链路 owner 统一负责。
  const refreshAll = uplink.refreshAll;

  // 升级状态机独立于 enrollment / rename / revoke：它走入口 → 目标的 peer link，hub 离线也能用。
  // 传 rows 是为了刷新后能按行回读升级状态——状态只活在 React 里，页面一刷新就得重新问一遍。
  const upgrade = useNodeUpgrade(rows, refreshAll);

  // 挂在 standby 上（或一台 writer 都没有）时，管理写入会被 hub 以 `HUB_NOT_WRITER` 拒绝：
  // 先禁掉动作并给一行说明，比让用户点完再吃一条报错强。升级不走 hub 控制面，保持可用。
  // 主 hub 掉线时「hub 不可达」与这一条说的是同一件事，只留更具体的那一条。
  // 中继模式下上级不是 hub：可写与否只看有没有挂上中继，hub 的主备 / writer 一概不适用。
  const writable = relay.relayMode ? relay.writable : hub.online && !hubs.writesBlocked;
  const blockedHint = uplinkBlockedHint(t, relay.relayMode, hubs.writesBlocked);

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
      </CardContent>
    </Card>
  );
}
