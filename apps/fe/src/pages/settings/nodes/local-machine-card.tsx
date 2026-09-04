// 本机卡：卡头（角色 + 唯一状态徽标 + 操作菜单）+ 连接 / 中继服务 / 网络三段正文。
//
// 直连的四个动作都只动磁盘与 env，运行中的 RTC 管理器无法热加载，后端恒返回
// `restartRequired: true`——网络那一段必须给出「立即重启」并等服务回来，否则用户会以为
// 操作没生效。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultLocalApi } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
  SetupRelayRole,
} from '@tmex/api-client/local/types';
import { Card, CardContent, CardHeader } from '@tmex/ui/card';
import { Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice, NoticeAction } from './card-parts';
import {
  type DirectApi,
  RemoveConfirm,
  describeDirectError,
  useDirectMutations,
} from './direct-section';
import { domainAccessApi, readDomainAccess } from './domain-access-row';
import { LocalMachineBody } from './local-machine-body';
import { LocalMachineHeader } from './local-machine-header';
import { machineStatusBadge } from './machine-status';
import type { SetupIntent } from './membership/intent';
import { LeaveDialog, type LeaveDialogRequest } from './membership/leave-dialog';
import { classifyRoleChange } from './membership/role-transition';
import { useLeaveMesh } from './membership/use-leave-mesh';
import { useRestartGateway } from './restart/use-restart-now';
import { useSetupCommitted } from './setup/setup-transition';
import { attachedHubRtt, resolveAttachedHub } from './uplink/hub-uplink-panel';
import type { LocalUplinkController } from './uplink/local-uplink-controller';

export interface LocalMachineCardProps {
  mode: AuthModeResponse | null;
  status: LocalStatusResponse | null;
  loading: boolean;
  loginRequired: boolean;
  /** `/api/local/status` 的非 401 失败：空着一张卡说不清任何事，必须给出原因与重试。 */
  error?: string | null;
  api?: DirectApi;
  client?: ApiClient;
  /** 上级链路（hub 集合 / 中继链路 / 中继动作）的唯一所有者，由 `NodesTab` 建好传下来。 */
  uplink: LocalUplinkController;
  /** 直连状态变更 / 重启完成后重新拉 `local-status`。 */
  onRefresh: () => void;
  /** standalone 下已选中的向导路径。 */
  wizardPath?: SetupIntent | null;
  /** standalone 下「本机作为中继」表单的预选角色。 */
  wizardRelayRole?: SetupRelayRole;
  /** 中继角色下「接入本机中继」的提示。 */
  selfRelayFollowUp?: boolean;
}

/** 「更换 Hub」：角色不变，退出后直接展开加入向导。 */
const CHANGE_HUB_REQUEST: LeaveDialogRequest = {
  kind: 'change-hub',
  from: 'node',
  target: 'node',
  targetRole: 'standalone',
  intent: { path: 'join-hub' },
};

/**
 * 角色切换：目标角色都要先退出当前 mesh，因此统一落到一份「待确认的退出请求」上，
 * 由 `LeaveDialog` 接手。standalone 不走这里——那台机器的下一步全在设置向导里。
 */
function useRoleSwitch(status: LocalStatusResponse | null, busy: boolean) {
  const [request, setRequest] = useState<LeaveDialogRequest | null>(null);
  const select = useCallback(
    (next: LocalRole) => {
      if (!status || busy) return;
      const transition = classifyRoleChange(status.role, next);
      // 只有 mesh → 别的角色会走到这里；其余分类（无变化 / 纯中继 / standalone 起步）不接。
      if (transition.kind !== 'leave' && transition.kind !== 'switch') return;
      setRequest(
        transition.kind === 'leave'
          ? {
              kind: 'leave',
              from: transition.from,
              target: next,
              targetRole: transition.targetRole,
              intent: null,
            }
          : {
              kind: 'switch',
              from: transition.from,
              target: next,
              targetRole: transition.targetRole,
              intent: transition.intent,
            }
      );
    },
    [busy, status]
  );
  return { request, setRequest, select };
}

/**
 * 动作的返回体就是权威结果，先盖在拉到的状态上：重新拉 `local-status` 是异步的，
 * 不盖的话开关会在这段时间里停在旧值。下一份状态到达（引用变了）即撤销。
 */
function useAppliedDirect(fetched: LocalDirectStatus | null) {
  const [applied, setApplied] = useState<Partial<LocalDirectStatus> | null>(null);
  const [seen, setSeen] = useState(fetched);
  if (seen !== fetched) {
    setSeen(fetched);
    setApplied(null);
  }
  return { direct: fetched && applied ? { ...fetched, ...applied } : fetched, setApplied };
}

export function LocalMachineCard({
  mode,
  status,
  loading,
  loginRequired,
  error = null,
  api = defaultLocalApi,
  client = defaultApiClient,
  uplink,
  onRefresh,
  wizardPath = null,
  wizardRelayRole = 'relay,node',
  selfRelayFollowUp = false,
}: LocalMachineCardProps) {
  const { t } = useTranslation();
  const meshEnabled = mode?.mode === 'mesh';
  const [restartRequired, setRestartRequired] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const leave = useLeaveMesh({ mode, client });
  const role = useRoleSwitch(status, leave.busy);
  // 某条设置路径已提交、正在等重启：换角色只会得到 409，锁上。
  const setupCommitted = useSetupCommitted();
  const { direct, setApplied } = useAppliedDirect(status?.direct ?? null);

  // 重启成功后插件已经加载，横幅必须先撤掉，否则用户会以为还要再重启一次。
  const onRestarted = useCallback(() => {
    setRestartRequired(false);
    onRefresh();
  }, [onRefresh]);
  const restart = useRestartGateway(client, onRestarted);

  const mutations = useDirectMutations(api, {
    onResult: (result) => {
      setDirectError(null);
      setApplied({
        installed: result.installed,
        enabled: result.enabled,
        capable: result.capable,
      });
      if (result.restartRequired) setRestartRequired(true);
    },
    onError: (failure) => setDirectError(describeDirectError(t, failure)),
    onRefresh,
  });

  const domainApi = useMemo(() => domainAccessApi(client), [client]);
  const badge = machineStatusBadge({
    standalone: !meshEnabled,
    roleKnown: status !== null,
    relayMode: uplink.relay.relayMode,
    relayAttached: uplink.relay.attached !== null,
    relayKicked: uplink.relay.kicked,
    hubAttached: resolveAttachedHub(uplink.hubs, mode?.nodeId ?? null).kind !== 'none',
    hubLoading: uplink.hub.loading,
    rttMs: uplink.relay.relayMode
      ? (uplink.relay.attached?.rttMs ?? null)
      : attachedHubRtt(uplink.hubs),
  });

  return (
    <Card data-testid="local-machine-card">
      <CardHeader>
        <LocalMachineHeader
          role={status?.role ?? null}
          status={badge}
          meshEnabled={meshEnabled}
          roleLocked={leave.busy || setupCommitted}
          onSelectRole={role.select}
          onLeave={() => role.select('standalone')}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error && !loginRequired && (
          <Notice
            tone="danger"
            testId="local-machine-error"
            action={
              <NoticeAction
                label={t('common.retry')}
                testId="local-machine-retry"
                onClick={onRefresh}
              />
            }
          >
            {t('nodes.machine.loadFailed', { detail: error })}
          </Notice>
        )}
        {loginRequired ? (
          <p className="text-xs text-muted-foreground" data-testid="local-machine-login-required">
            {t('nodes.machine.loginRequired')}
          </p>
        ) : loading && !status ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : status && direct ? (
          <LocalMachineBody
            mode={mode}
            status={status}
            direct={direct}
            uplink={uplink}
            standalone={!meshEnabled}
            wizardPath={wizardPath}
            wizardRelayRole={wizardRelayRole}
            selfRelayFollowUp={selfRelayFollowUp}
            changeHubDisabled={leave.busy}
            onChangeHub={() => role.setRequest(CHANGE_HUB_REQUEST)}
            directBusy={mutations.busy || restart.waiting}
            directPending={mutations.pending}
            directError={directError}
            onDirectAction={(action) => {
              if (action !== 'remove') setDirectError(null);
              mutations.dispatch(action);
            }}
            restartRequired={restartRequired}
            restart={restart}
            domainAccess={readDomainAccess(status)}
            domainApi={domainApi}
            onRefresh={onRefresh}
          />
        ) : null}
      </CardContent>

      <RemoveConfirm
        open={mutations.confirmingRemove}
        relayMode={uplink.relay.relayMode}
        onConfirm={mutations.confirmRemove}
        onCancel={mutations.cancelRemove}
      />
      <LeaveDialog
        request={role.request}
        leave={leave}
        onConfirm={() => {
          if (role.request) {
            leave.run({
              from: role.request.from,
              targetRole: role.request.targetRole,
              intent: role.request.intent,
            });
          }
        }}
        onCancel={() => {
          role.setRequest(null);
          leave.reset();
        }}
      />
      {leave.dialog}
      {uplink.prompt.dialog}
    </Card>
  );
}
