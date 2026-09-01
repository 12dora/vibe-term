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
import {
  type NodeRow,
  mergeNodes,
  setEntryNodeId,
  useHubNode,
  useMeshNodes,
} from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { CircleArrowUp, Loader2, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { EnrollmentSection } from './enrollment-section';
import { NodesTable } from './nodes-table';
import { type NodeUpgradeController, PLACEHOLDER_KDF, type ResolvedMode } from './types';
import { useNodeUpgrade } from './use-node-upgrade';

export interface NodesManagementProps {
  mode: AuthModeResponse;
  api?: AuthApi;
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
  const rows = useMemo(
    () => mergeNodes(nodes, hub.hubNodes, { entryNodeId, hubNodeId: hub.hubNodeId }),
    [nodes, hub.hubNodes, hub.hubNodeId, entryNodeId]
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

  // 管理动作可以用密码，也可以用本入口已注册的 passkey（设计 §2「用户密钥」）。
  const { passkeys } = usePasskeys(api, { enabled: hasCredentials && rawMode.passkeyAvailable });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode.rootPublicKey),
    passkeys,
    passkeyAvailable: rawMode.passkeyAvailable,
  });

  const refreshAll = useCallback(() => {
    refreshNodes();
    hub.refresh();
  }, [hub, refreshNodes]);

  // 升级状态机独立于 enrollment / rename / revoke：它走入口 → 目标的 peer link，hub 离线也能用。
  const upgrade = useNodeUpgrade(refreshAll);

  const [enrollOpen, setEnrollOpen] = useState(false);
  // 监听回路、admit 流水线与过期清理都在宿主级单例引擎里：侧滑面板同时开着时也只有一份，
  // 同一张证书绝不会被签成两条 `admit-node`（见 `enrollment-engine.ts` 顶部）。
  const { confirmManually } = useEnrollmentEngine({
    api,
    mode,
    hubApi: hub.hubApi,
    prompt,
    onDone: refreshAll,
    t,
  });
  const engine = useEnrollmentEngineState();

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
          <UpgradeAllButton rows={rows} upgrade={upgrade} />
          <Button
            type="button"
            size="sm"
            disabled={!hub.online}
            title={hub.online ? undefined : t('nodes.hubOffline')}
            onClick={() => setEnrollOpen((value) => !value)}
            data-testid="nodes-add"
          >
            <Plus />
            {t('nodes.actions.add')}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {!hub.online && (
          <p
            className="flex items-center gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
            data-testid="nodes-hub-offline"
          >
            <ShieldAlert className="size-3.5 shrink-0" />
            {t('nodes.hubOffline')}
          </p>
        )}

        <EnrollmentSection
          api={api}
          mode={mode}
          hubApi={hub.hubApi}
          hubOnline={hub.online}
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
          hubOnline={hub.online}
          mode={mode}
          api={api}
          prompt={prompt}
          onChanged={refreshAll}
          upgrade={upgrade}
        />

        {prompt.dialog}
      </CardContent>
    </Card>
  );
}

/**
 * 「全部升级」：latest 未知、批量正在跑、没有可升级节点时禁用。
 * 顺序、并发与汇总提示都在 `useNodeUpgrade` 里，这里只负责按钮态与进度文案。
 */
function UpgradeAllButton({
  rows,
  upgrade,
}: {
  rows: NodeRow[];
  upgrade: NodeUpgradeController;
}) {
  const { t } = useTranslation();
  const latestVersion = upgrade.latest?.latestVersion ?? null;
  const { running, completed, total } = upgrade.batch;
  const count = upgrade.eligibleCount(rows);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!latestVersion || running || count === 0}
      title={upgradeAllHint(t, latestVersion, count)}
      onClick={() => upgrade.startAll(rows)}
      data-testid="nodes-upgrade-all"
    >
      {running ? (
        <Loader2 className="animate-spin motion-reduce:animate-none" />
      ) : (
        <CircleArrowUp />
      )}
      {running
        ? t('nodes.upgrade.allProgress', { completed, total })
        : t('nodes.upgrade.upgradeAll')}
    </Button>
  );
}

function upgradeAllHint(
  t: (key: string, options?: Record<string, unknown>) => string,
  latestVersion: string | null,
  count: number
): string {
  if (!latestVersion) return t('nodes.upgrade.releaseUnavailable');
  if (count === 0) return t('nodes.upgrade.allNone');
  return t('nodes.upgrade.allHint', { count, version: latestVersion });
}
