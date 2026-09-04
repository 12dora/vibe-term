// 本机区块：角色、上级链路两个 tab（接入 Hub / 接入中继）、直连插件与通用设置。
// 直连的四个动作都只动磁盘与 env，运行中的
// RTC 管理器无法热加载，后端恒返回 `restartRequired: true`——这里必须给出「立即重启」并等服务
// 回来，否则用户会以为操作没生效。

import { SIDE_PANEL_LINK_STATE, useSidePanel } from '@/components/side-panels/use-side-panel';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultLocalApi } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
} from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Loader2, RotateCcw } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Row } from './copy-feedback';
import {
  type DirectApi,
  DirectSection,
  RemoveConfirm,
  describeDirectError,
  useDirectMutations,
} from './direct-section';
import { DomainAccessRow, domainAccessApi, readDomainAccess } from './domain-access-row';
import type { SetupIntent } from './membership/intent';
import { LeaveDialog, type LeaveDialogRequest } from './membership/leave-dialog';
import { ROLE_LABEL_KEY, classifyRoleChange } from './membership/role-transition';
import { useLeaveMesh } from './membership/use-leave-mesh';
import {
  type RestartGateway,
  type RestartState,
  useRestartGateway,
} from './restart/use-restart-now';
import type { LocalUplinkController } from './uplink/local-uplink-controller';
import { LocalUplinkTabs } from './uplink/local-uplink-tabs';

export interface LocalMachineCardProps {
  mode: AuthModeResponse | null;
  status: LocalStatusResponse | null;
  loading: boolean;
  loginRequired: boolean;
  api?: DirectApi;
  client?: ApiClient;
  /** 上级链路（hub 集合 / 中继链路 / 中继动作）的唯一所有者，由 `NodesTab` 建好传下来。 */
  uplink: LocalUplinkController;
  /** 直连状态变更 / 重启完成后重新拉 `local-status`。 */
  onRefresh: () => void;
  /** standalone 下切角色不调任何接口，只让上层把对应的向导路径展开。 */
  onSelectSetupPath?: (path: SetupIntent) => void;
  /** standalone 下已选中的 Hub 向导路径。 */
  wizardPath?: SetupIntent | null;
  /** standalone 下「本机作为中继」表单的插槽。 */
  relaySetup?: ReactNode;
}

/** 后端只认这三个角色串（`packages/app/src/lib/roles.ts`）。 */
const SELECTABLE_ROLES: LocalRole[] = ['standalone', 'node', 'hub,node'];

/** 「更换 Hub」：角色不变，退出后直接展开加入向导。 */
const CHANGE_HUB_REQUEST: LeaveDialogRequest = {
  kind: 'change-hub',
  from: 'node',
  target: 'node',
  intent: 'join-hub',
};

/**
 * 角色切换：standalone → mesh 只展开向导；mesh 侧的两种目标都要先退出当前 mesh，
 * 因此统一落到一份「待确认的退出请求」上，由 `LeaveDialog` 接手。
 */
function useRoleSwitch(
  status: LocalStatusResponse | null,
  busy: boolean,
  onSelectSetupPath?: (path: SetupIntent) => void
) {
  const [request, setRequest] = useState<LeaveDialogRequest | null>(null);
  const select = useCallback(
    (next: LocalRole) => {
      if (!status || busy) return;
      const transition = classifyRoleChange(status.role, next);
      if (transition.kind === 'none') return;
      if (transition.kind === 'setup') {
        onSelectSetupPath?.(transition.path);
        return;
      }
      setRequest(
        transition.kind === 'leave'
          ? { kind: 'leave', from: transition.from, target: next, intent: null }
          : { kind: 'switch', from: transition.from, target: next, intent: transition.path }
      );
    },
    [busy, onSelectSetupPath, status]
  );
  return { request, setRequest, select };
}

export function LocalMachineCard({
  mode,
  status,
  loading,
  loginRequired,
  api = defaultLocalApi,
  client = defaultApiClient,
  uplink,
  onRefresh,
  onSelectSetupPath,
  wizardPath = null,
  relaySetup = null,
}: LocalMachineCardProps) {
  const { t } = useTranslation();
  const meshEnabled = mode?.mode === 'mesh';
  // 账号安全改成右侧滑出面板，链接只换查询串，留在当前页面。
  const { hrefFor: panelHref } = useSidePanel();
  const [restartRequired, setRestartRequired] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const leave = useLeaveMesh({ mode, client });
  const role = useRoleSwitch(status, leave.busy, onSelectSetupPath);

  // 动作的返回体就是权威结果，先盖在拉到的状态上：重新拉 `local-status` 是异步的，
  // 不盖的话开关会在这段时间里停在旧值。下一份状态到达（引用变了）即撤销。
  const fetched: LocalDirectStatus | null = status?.direct ?? null;
  const [applied, setApplied] = useState<Partial<LocalDirectStatus> | null>(null);
  const [seen, setSeen] = useState(fetched);
  if (seen !== fetched) {
    setSeen(fetched);
    setApplied(null);
  }
  const direct = fetched && applied ? { ...fetched, ...applied } : fetched;

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
    onError: (error) => setDirectError(describeDirectError(t, error)),
    onRefresh,
  });

  const busy = mutations.busy || restart.waiting;
  const domainAccess = readDomainAccess(status);
  const domainApi = useMemo(() => domainAccessApi(client), [client]);

  return (
    <Card data-testid="local-machine-card">
      <CardHeader>
        <CardTitle>{t('nodes.machine.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loginRequired ? (
          <p className="text-xs text-muted-foreground" data-testid="local-machine-login-required">
            {t('nodes.machine.loginRequired')}
          </p>
        ) : loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : status && direct ? (
          <>
            <RoleRow
              current={status.role}
              disabled={leave.busy}
              onSelect={(next) => role.select(next)}
            />

            <LocalUplinkTabs
              status={status}
              selfNodeId={mode?.nodeId ?? null}
              standalone={!meshEnabled}
              uplink={uplink}
              changeHubDisabled={leave.busy}
              onChangeHub={() => role.setRequest(CHANGE_HUB_REQUEST)}
              wizardPath={wizardPath}
              relaySetup={relaySetup}
            />

            <DirectSection
              direct={direct}
              busy={busy}
              pending={mutations.pending}
              error={directError}
              onAction={(action) => {
                if (action !== 'remove') setDirectError(null);
                mutations.dispatch(action);
              }}
            />

            {restartRequired && <RestartBanner restart={restart} busy={busy} />}

            {domainAccess && (
              <>
                <p className="pt-1 text-xs font-medium" data-testid="local-machine-general-heading">
                  {t('nodes.machine.general')}
                </p>
                <DomainAccessRow policy={domainAccess} api={domainApi} onRefresh={onRefresh} />
              </>
            )}
          </>
        ) : null}

        {meshEnabled && (
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
            <Link
              to={panelHref('security')}
              state={SIDE_PANEL_LINK_STATE}
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              data-testid="local-machine-account-security"
            >
              {t('nodes.machine.accountSecurity')}
            </Link>
          </div>
        )}
      </CardContent>

      <RemoveConfirm
        open={mutations.confirmingRemove}
        onConfirm={mutations.confirmRemove}
        onCancel={mutations.cancelRemove}
      />

      <LeaveDialog
        request={role.request}
        leave={leave}
        onConfirm={() => {
          if (role.request) leave.run({ from: role.request.from, intent: role.request.intent });
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

/** 角色下拉：后端只认 `SELECTABLE_ROLES` 里的角色串。 */
function RoleRow({
  current,
  disabled,
  onSelect,
}: {
  current: LocalRole;
  disabled: boolean;
  onSelect: (role: LocalRole) => void;
}) {
  const { t } = useTranslation();
  return (
    <Row label={t('nodes.machine.role')}>
      <Select value={current} onValueChange={(next) => next && onSelect(next as LocalRole)}>
        <SelectTrigger
          size="sm"
          className="w-48"
          disabled={disabled}
          data-testid="local-machine-role"
        >
          <SelectValue>{t(ROLE_LABEL_KEY[current])}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SELECTABLE_ROLES.map((item) => (
            <SelectItem key={item} value={item} data-testid={`local-machine-role-${item}`}>
              {t(ROLE_LABEL_KEY[item])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

const RESTART_TEXT_KEY: Partial<Record<RestartState, string>> = {
  waiting: 'nodes.machine.restarting',
  timeout: 'nodes.machine.restartTimeout',
};

function RestartBanner({ restart, busy }: { restart: RestartGateway; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2 text-xs"
      data-testid="local-machine-restart-required"
    >
      <span className="text-muted-foreground">
        {t(RESTART_TEXT_KEY[restart.state] ?? 'nodes.machine.directRestartRequired')}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => void restart.run()}
        data-testid="local-machine-restart-now"
      >
        {restart.waiting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        {t('nodes.machine.restartNow')}
      </Button>
    </div>
  );
}
