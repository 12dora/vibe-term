// mesh 节点管理主体（设计 §4「Nodes 管理页」）。
//
// 列表 = `GET /api/mesh/nodes`（成员集权威）合并 `GET /n/<hub>/api/hub/nodes`（心跳 / 状态）。
// 动作：新增节点（enrollment）、重命名、吊销。hub 不可达时全部管理动作禁用。
//
// 整体是设置页「节点」标签里的一张卡片：卡头放刷新与「添加」，卡体依次是 hub 离线提示、
// 加入码表单、待确认列表与节点表——不再有第二层外框。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import {
  listPendingEnrollments,
  nextPendingExpiry,
  prunePendingEnrollments,
  removePendingEnrollment,
  subscribePendingEnrollments,
} from '@/node/enrollment';
import { useEnrollmentWatch } from '@/node/enrollment-watch';
import { mergeNodes, setEntryNodeId, useHubNode, useMeshNodes } from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { EnrollmentSection } from './enrollment-section';
import { NodesTable } from './nodes-table';
import { PLACEHOLDER_KDF, type ResolvedMode } from './types';
import { useAdmitAction } from './use-admit-action';

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

  const [expiredIds, setExpiredIds] = useState<string[]>([]);
  const [cancelledIds, setCancelledIds] = useState<string[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  // 取消只删本地 pending（hub 侧记录会自然过期）；同时把 id 记入 cleared，join 串立刻消失
  const cancelPending = useCallback((pending: { hubEnrollmentId: string }) => {
    removePendingEnrollment(pending.hubEnrollmentId);
    setCancelledIds((prev) => [...prev, pending.hubEnrollmentId]);
  }, []);
  const admit = useAdmitAction({ api, mode, hubApi: hub.hubApi, prompt, onDone: refreshAll });

  useEnrollmentWatch({
    pendings,
    hubApi: hub.hubApi,
    onOutcome: (outcome) => void admit.handleOutcome(outcome),
  });

  // 过期清理必须是**定时**的：页面一直开着时，十分钟前建的 pending 不能继续留在
  // 内存与 sessionStorage 里，对应的 join 串也不能继续留在 DOM（见 F4-3 评审 Major）。
  useEffect(() => {
    const sweep = () => {
      const removed = prunePendingEnrollments(Date.now());
      if (removed.length > 0) setExpiredIds(removed.map((row) => row.hubEnrollmentId));
    };
    sweep();
    const next = nextPendingExpiry(pendings);
    if (next === null) return;
    const timer = setTimeout(sweep, Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [pendings]);

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
          onConfirm={(pending) => void admit.confirmManually(pending)}
          onCancel={cancelPending}
          busyPendingId={admit.busyPendingId}
          hubUnconfirmedIds={admit.hubUnconfirmedIds}
          clearedIds={[...expiredIds, ...cancelledIds, ...admit.admittedIds]}
        />

        <NodesTable
          rows={rows}
          hubApi={hub.hubApi}
          hubOnline={hub.online}
          mode={mode}
          api={api}
          prompt={prompt}
          onChanged={refreshAll}
        />

        {prompt.dialog}
      </CardContent>
    </Card>
  );
}
