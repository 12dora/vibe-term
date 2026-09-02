// 本机区块：角色、两个地址（本机对外地址 / 当前挂载的 Hub）、直连插件与通用设置。
// 直连的四个动作都只动磁盘与 env，运行中的
// RTC 管理器无法热加载，后端恒返回 `restartRequired: true`——这里必须给出「立即重启」并等服务
// 回来，否则用户会以为操作没生效。

import { SIDE_PANEL_LINK_STATE, useSidePanel } from '@/components/side-panels/use-side-panel';
import { type MeshHubsState, attachedHubId, useMeshHubs, writerHub } from '@/node/mesh-hubs';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthModeResponse, MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { defaultLocalApi } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
} from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Loader2, Repeat, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CopyableValue, Row } from './copy-feedback';
import {
  type DirectApi,
  DirectSection,
  RemoveConfirm,
  describeDirectError,
  useDirectMutations,
} from './direct-section';
import { DomainAccessRow, domainAccessApi, readDomainAccess } from './domain-access-row';
import { HubModeTag, hubLabel, hubModeLabel, normalizeHubUrl } from './management/hub-strip';
import type { SetupIntent } from './membership/intent';
import { LeaveDialog, type LeaveDialogRequest } from './membership/leave-dialog';
import { ROLE_LABEL_KEY, classifyRoleChange } from './membership/role-transition';
import { useLeaveMesh } from './membership/use-leave-mesh';
import {
  type RestartGateway,
  type RestartState,
  useRestartGateway,
} from './restart/use-restart-now';

export interface LocalMachineCardProps {
  mode: AuthModeResponse | null;
  status: LocalStatusResponse | null;
  loading: boolean;
  loginRequired: boolean;
  api?: DirectApi;
  client?: ApiClient;
  /** 直连状态变更 / 重启完成后重新拉 `local-status`。 */
  onRefresh: () => void;
  /** standalone 下切角色不调任何接口，只让上层把对应的向导路径展开。 */
  onSelectSetupPath?: (path: SetupIntent) => void;
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
  onRefresh,
  onSelectSetupPath,
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
            <Row label={t('nodes.machine.role')}>
              <Select
                value={status.role}
                onValueChange={(next) => next && role.select(next as LocalRole)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-48"
                  disabled={leave.busy}
                  data-testid="local-machine-role"
                >
                  <SelectValue>{t(ROLE_LABEL_KEY[status.role])}</SelectValue>
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

            <MachineHubRows
              role={status.role}
              selfNodeId={mode?.nodeId ?? null}
              enabled={meshEnabled}
              hubUrl={status.hubUrl}
              hubPublicUrl={status.hubPublicUrl}
              changeHubDisabled={leave.busy}
              onChangeHub={() => role.setRequest(CHANGE_HUB_REQUEST)}
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
    </Card>
  );
}

/**
 * 本机挂载的那台 hub：`attached` 给出 hubNodeId 时按它取；没有 uplink（hub 机自己就是 hub）
 * 时退回集合里的本机那一行。集合里查不到就返回 `null`，不拿 `hubUrl` 那个入会种子充数。
 */
function resolveAttachedHub(
  snapshot: MeshHubsState,
  selfNodeId: string | null
): MeshHubEndpoint | null {
  const attachedId = attachedHubId(snapshot);
  if (attachedId) return snapshot.hubs.find((hub) => hub.nodeId === attachedId) ?? null;
  return snapshot.hubs.find((hub) => hub.nodeId === selfNodeId) ?? null;
}

/** 列表次序：writer 打头，其余按优先级——用户先看的是「谁收写入」。 */
function orderHubs(hubs: MeshHubEndpoint[], writerHubId: string | null): MeshHubEndpoint[] {
  return [...hubs].sort((a, b) => {
    const rank = (hub: MeshHubEndpoint) => (hub.nodeId === writerHubId ? 0 : 1);
    return rank(a) - rank(b) || a.priority - b.priority;
  });
}

/**
 * 本机的两个地址：
 * - 「本机地址」= `hubPublicUrl`，只有 hub 角色才有，是别人访问本机的地址；
 * - 「当前 Hub」= 真正挂载的那台 hub。`/api/local/status` 的 `hubUrl` 只是入会时写死的种子，
 *   主备切换后早已不是当前挂载的那台，所以它只作为副行补充，不再单独占一行。
 */
function MachineHubRows({
  role,
  selfNodeId,
  enabled,
  hubUrl,
  hubPublicUrl,
  changeHubDisabled,
  onChangeHub,
}: {
  role: LocalRole;
  selfNodeId: string | null;
  enabled: boolean;
  hubUrl: string | null;
  hubPublicUrl: string | null;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
}) {
  const { t } = useTranslation();
  const meshRole = role === 'node' || role === 'hub,node';
  const snapshot = useMeshHubs({ enabled: enabled && meshRole });
  // 本机的主 / 备身份：`/api/local/status` 不下发 hubMode，只能从 hub 集合里按自身 nodeId 取。
  // 集合里没有本机（旧入口、集合还没拉到）时整行不渲染，不做任何猜测。
  const localHubMode =
    role === 'hub,node'
      ? (snapshot.hubs.find((hub) => hub.nodeId && hub.nodeId === selfNodeId)?.mode ?? null)
      : null;
  const attached = meshRole ? resolveAttachedHub(snapshot, selfNodeId) : null;
  return (
    <>
      {localHubMode && (
        <Row label={t('nodes.hubs.machineRole')}>
          <span className="text-xs" data-testid="local-machine-hub-mode">
            {hubModeLabel(t, localHubMode)}
          </span>
        </Row>
      )}
      {role === 'hub,node' && <LocalAddressRow publicUrl={hubPublicUrl} />}
      {meshRole && (attached || hubUrl) && (
        <CurrentHubRow
          hub={attached}
          isSelf={Boolean(attached && attached.nodeId === selfNodeId)}
          writer={writerHub(snapshot)}
          seedUrl={hubUrl}
          {...(role === 'node'
            ? { changeHub: { disabled: changeHubDisabled, onChange: onChangeHub } }
            : {})}
        />
      )}
      {meshRole && snapshot.hubs.length >= 2 && (
        <HubListRow hubs={orderHubs(snapshot.hubs, snapshot.writerHubId)} />
      )}
    </>
  );
}

/** 别人访问本机 hub 用的地址；没设置时说清后果，指回角色设置。 */
function LocalAddressRow({ publicUrl }: { publicUrl: string | null }) {
  const { t } = useTranslation();
  return (
    <Row label={t('nodes.machine.localAddress')}>
      {publicUrl ? (
        <CopyableValue value={publicUrl} testId="local-machine-local-address" />
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span data-testid="local-machine-local-address-unset">
            {t('nodes.machine.localAddressUnset')}
          </span>
          <span className="text-muted-foreground">{t('nodes.machine.localAddressHint')}</span>
        </span>
      )}
    </Row>
  );
}

/** 入会种子与当前挂载地址不一致时才补出种子——一致时多这一行只是噪音。 */
function seedLine(seedUrl: string | null, hub: MeshHubEndpoint | null): string | null {
  if (!seedUrl || !hub) return null;
  return normalizeHubUrl(seedUrl) === normalizeHubUrl(hub.publicUrl) ? null : seedUrl;
}

function CurrentHubRow({
  hub,
  isSelf,
  writer,
  seedUrl,
  changeHub,
}: {
  /** hub 集合还没拉到时为 `null`，此时行里只摆入会种子。 */
  hub: MeshHubEndpoint | null;
  isSelf: boolean;
  writer: MeshHubEndpoint | null;
  seedUrl: string | null;
  changeHub?: { disabled: boolean; onChange: () => void };
}) {
  const { t } = useTranslation();
  // 挂在备 hub 上时写入其实落在别处，同一行补出 writer，省得用户去 hub 管理面对照。
  const elsewhere = hub && writer && writer.nodeId !== hub.nodeId ? writer : null;
  const seed = seedLine(seedUrl, hub);
  return (
    <Row label={t('nodes.machine.currentHub')}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {hub ? (
            <>
              <span
                className="flex items-center gap-1.5 text-xs"
                data-testid="local-machine-attached-hub"
              >
                <span className="font-medium">
                  {isSelf ? t('nodes.machine.self') : hubLabel(hub)}
                </span>
                <HubModeTag mode={hub.mode} testId="local-machine-attached-hub-mode" />
              </span>
              {!isSelf && (
                <CopyableValue value={hub.publicUrl} testId="local-machine-attached-hub-url" />
              )}
            </>
          ) : (
            seedUrl && <CopyableValue value={seedUrl} testId="local-machine-hub-url" />
          )}
          {elsewhere && (
            <span className="text-xs text-muted-foreground" data-testid="local-machine-writer-hub">
              {t('nodes.machine.writerHub', { name: hubLabel(elsewhere) })}
            </span>
          )}
          {changeHub && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={changeHub.disabled}
              onClick={changeHub.onChange}
              data-testid="local-machine-change-hub"
            >
              <Repeat />
              {t('nodes.membership.changeHub')}
            </Button>
          )}
        </div>
        {seed && (
          <span className="text-xs text-muted-foreground" data-testid="local-machine-join-seed">
            {t('nodes.machine.joinSeed', { url: seed })}
          </span>
        )}
      </div>
    </Row>
  );
}

function HubListRow({ hubs }: { hubs: MeshHubEndpoint[] }) {
  const { t } = useTranslation();
  return (
    <Row label={t('nodes.machine.hubList')}>
      <span className="flex flex-wrap items-center gap-1.5" data-testid="local-machine-hub-list">
        {hubs.map((hub) => (
          <MachineHubChip key={hub.nodeId} hub={hub} />
        ))}
      </span>
    </Row>
  );
}

function MachineHubChip({ hub }: { hub: MeshHubEndpoint }) {
  const { t } = useTranslation();
  const offline = hub.online === false;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px]"
      data-testid={`local-machine-hub-item-${hub.nodeId}`}
      data-hub-mode={hub.mode}
      data-hub-online={offline ? 'false' : 'true'}
    >
      <span className="truncate font-medium">{hubLabel(hub)}</span>
      <span className="text-muted-foreground">{hubModeLabel(t, hub.mode)}</span>
      {offline && (
        <span
          className="text-muted-foreground"
          data-testid={`local-machine-hub-offline-${hub.nodeId}`}
        >
          {t('nodes.hubs.offline')}
        </span>
      )}
    </span>
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
