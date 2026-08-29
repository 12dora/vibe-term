// mesh 节点管理主体（设计 §4「Nodes 管理页」）。
//
// 列表 = `GET /api/mesh/nodes`（成员集权威）合并 `GET /n/<hub>/api/hub/nodes`（心跳 / 状态）。
// 动作：新增节点（enrollment）、重命名、吊销。hub 不可达时全部管理动作禁用。
//
// 同一份主体被 `/nodes` 整页与设置页「节点」标签复用：`compact` 只影响外层容器与页头，
// 数据管线与动作完全一致。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import {
  listPendingEnrollments,
  nextPendingExpiry,
  prunePendingEnrollments,
  subscribePendingEnrollments,
} from '@/node/enrollment';
import { useEnrollmentWatch } from '@/node/enrollment-watch';
import { mergeNodes, setEntryNodeId, useHubNode, useMeshNodes } from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { EnrollmentSection } from './enrollment-section';
import { NodesTable } from './nodes-table';
import { PLACEHOLDER_KDF, type ResolvedMode } from './types';
import { useAdmitAction } from './use-admit-action';

export interface NodesManagementProps {
  mode: AuthModeResponse;
  api?: AuthApi;
  /** 默认显示「账号安全」入口；设置页里由本机区块自己给这个入口，这里关掉。 */
  showAccountSecurityLink?: boolean;
  /** 嵌在别的页面里：去掉页级标题与外层留白。 */
  compact?: boolean;
}

export function NodesManagement({
  mode: rawMode,
  api = defaultAuthApi,
  showAccountSecurityLink = true,
  compact = false,
}: NodesManagementProps) {
  const { t } = useTranslation();
  const { nodes, refresh: refreshNodes } = useMeshNodes();
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
      <div
        className={
          compact
            ? 'text-sm text-muted-foreground'
            : 'mx-auto w-full max-w-5xl p-5 text-sm text-muted-foreground'
        }
      >
        {t('auth.errors.UNKNOWN_USER')}
      </div>
    );
  }

  return (
    <div
      className={
        compact
          ? 'flex w-full flex-col gap-4'
          : 'mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-5'
      }
    >
      <header
        className={
          compact
            ? 'flex flex-wrap items-center justify-end gap-2'
            : 'flex flex-wrap items-center justify-between gap-2'
        }
      >
        {!compact && (
          <div className="flex flex-col gap-0.5">
            <h1 className="text-sm font-semibold">{t('nodes.title')}</h1>
            <p className="text-xs text-muted-foreground">{t('nodes.subtitle')}</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refreshAll}
            data-testid="nodes-refresh"
          >
            <RefreshCw />
            {t('nodes.actions.refresh')}
          </Button>
          {showAccountSecurityLink && (
            <Link
              to="/account/security"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              data-testid="nodes-account-security"
            >
              {t('nodes.actions.accountSecurity')}
            </Link>
          )}
        </div>
      </header>

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
        prompt={prompt}
        pendings={pendings}
        onConfirm={(pending) => void admit.confirmManually(pending)}
        busyPendingId={admit.busyPendingId}
        hubUnconfirmedIds={admit.hubUnconfirmedIds}
        clearedIds={[...expiredIds, ...admit.admittedIds]}
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
    </div>
  );
}
