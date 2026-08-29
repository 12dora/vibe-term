// 本机区块：角色、hub 地址、直连插件的安装与开关。
//
// 安装（下载 `native/`）和启用（`TMEX_DIRECT_ENABLED`）是两件独立的事：装好的插件可以先关着，
// 关掉也不必删文件——所以按钮管安装/删除，开关管启用/停用，两者只在「未安装时开关不可用」上耦合。
//
// 四个动作都只动磁盘与 env，运行中的 RTC 管理器无法热加载，后端恒返回 `restartRequired: true`
// ——这里必须给出「立即重启」并等服务回来，否则用户会以为操作没生效。

import { SIDE_PANEL_LINK_STATE, useSidePanel } from '@/components/side-panels/use-side-panel';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { LocalApiError, defaultLocalApi } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalDirectStatus,
  LocalRole,
  LocalStatusResponse,
} from '@tmex/api-client/local/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Switch } from '@tmex/ui/switch';
import { Check, Copy, Download, Loader2, Repeat, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CopyLabel, useCopyToClipboard } from './copy-feedback';
import type { SetupIntent } from './membership/intent';
import { LeaveDialog, type LeaveDialogRequest } from './membership/leave-dialog';
import { classifyRoleChange } from './membership/role-transition';
import { useLeaveMesh } from './membership/use-leave-mesh';
import { useRestartGateway } from './restart/use-restart-now';

/** 只取 `LocalApi` 的直连那一面，测试注入假实现时不必凑出整个客户端。 */
export interface DirectApi {
  setDirect(action: LocalDirectAction): Promise<LocalDirectResponse>;
}

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

const ROLE_LABEL_KEY: Record<LocalRole, string> = {
  standalone: 'nodes.machine.roleStandalone',
  node: 'nodes.machine.roleNode',
  'hub,node': 'nodes.machine.roleHub',
};

/** 后端只认这三个角色串（`packages/app/src/lib/roles.ts`）。 */
export const SELECTABLE_ROLES: LocalRole[] = ['standalone', 'node', 'hub,node'];

/** 这些错误码的 `message` 才是诊断信息（下载失败的原因、加载失败的 dlopen 报错）。 */
const DIRECT_ERROR_KEY: Record<string, string> = {
  direct_unsupported: 'nodes.machine.directErrorUnsupported',
  direct_download_failed: 'nodes.machine.directErrorDownloadFailed',
  direct_not_installed: 'nodes.machine.directErrorNotInstalled',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function describeDirectError(t: Translate, error: unknown): string {
  const base = t(
    (error instanceof LocalApiError && DIRECT_ERROR_KEY[error.code]) || 'nodes.machine.directFailed'
  );
  const detail = (error instanceof Error ? error.message : String(error)).trim();
  const code = error instanceof LocalApiError ? error.code : '';
  if (!detail || detail === code) return base;
  return t('nodes.machine.directErrorDetail', { base, detail });
}

export interface DirectMutationState {
  pending: LocalDirectAction | null;
  /** 删除插件前的二次确认。 */
  confirmingRemove: boolean;
}

export interface DirectMutationCallbacks {
  onResult: (result: LocalDirectResponse) => void;
  onError: (error: unknown) => void;
  onRefresh: () => void;
}

/**
 * 四个动作共用一把锁：安装要下载最多 60 s，期间再点删除 / 拨开关只会让 `native/` 和 env
 * 互相打架。状态放在可订阅的控制器里而不是组件 state，锁与确认流程才能脱离 DOM 直接测。
 */
export class DirectMutationController {
  private state: DirectMutationState = { pending: null, confirmingRemove: false };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: DirectApi,
    private readonly readCallbacks: () => DirectMutationCallbacks
  ) {}

  snapshot = (): DirectMutationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return this.state.pending !== null;
  }

  run = async (action: LocalDirectAction): Promise<void> => {
    if (this.busy || this.state.confirmingRemove) return;
    await this.perform(action);
  };

  requestRemove = (): void => {
    if (this.busy || this.state.confirmingRemove) return;
    this.update({ confirmingRemove: true });
  };

  confirmRemove = async (): Promise<void> => {
    if (!this.state.confirmingRemove) return;
    this.update({ confirmingRemove: false });
    if (this.busy) return;
    await this.perform('remove');
  };

  cancelRemove = (): void => {
    if (this.state.confirmingRemove) this.update({ confirmingRemove: false });
  };

  private async perform(action: LocalDirectAction): Promise<void> {
    this.update({ pending: action });
    try {
      const result = await this.api.setDirect(action);
      this.readCallbacks().onResult(result);
    } catch (error) {
      this.readCallbacks().onError(error);
    } finally {
      this.update({ pending: null });
      // 成功要拿到权威状态，失败也要——下载失败时 `native/` 可能已被清干净。
      this.readCallbacks().onRefresh();
    }
  }

  private update(patch: Partial<DirectMutationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export interface DirectMutations extends DirectMutationState {
  busy: boolean;
  run: (action: LocalDirectAction) => void;
  requestRemove: () => void;
  confirmRemove: () => void;
  cancelRemove: () => void;
}

export function useDirectMutations(
  api: DirectApi,
  callbacks: DirectMutationCallbacks
): DirectMutations {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const controller = useMemo(
    () => new DirectMutationController(api, () => callbacksRef.current),
    [api]
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );

  return {
    ...state,
    busy: state.pending !== null,
    run: (action) => void controller.run(action),
    requestRemove: controller.requestRemove,
    confirmRemove: () => void controller.confirmRemove(),
    cancelRemove: controller.cancelRemove,
  };
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
  const [leaveRequest, setLeaveRequest] = useState<LeaveDialogRequest | null>(null);
  const leave = useLeaveMesh({ mode, client });

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

  // 角色切换：standalone → mesh 只展开向导；mesh 侧的两种目标都要先退出当前 mesh。
  const changeRole = useCallback(
    (next: LocalRole) => {
      if (!status || leave.busy) return;
      const transition = classifyRoleChange(status.role, next);
      if (transition.kind === 'none') return;
      if (transition.kind === 'setup') {
        onSelectSetupPath?.(transition.path);
        return;
      }
      setLeaveRequest(
        transition.kind === 'leave'
          ? { kind: 'leave', from: transition.from, target: next, intent: null }
          : { kind: 'switch', from: transition.from, target: next, intent: transition.path }
      );
    },
    [leave.busy, onSelectSetupPath, status]
  );

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
                onValueChange={(next) => {
                  if (next) changeRole(next as LocalRole);
                }}
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
                  {SELECTABLE_ROLES.map((role) => (
                    <SelectItem key={role} value={role} data-testid={`local-machine-role-${role}`}>
                      {t(ROLE_LABEL_KEY[role])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>

            {status.hubUrl && (
              <Row label={t('nodes.machine.hubUrl')}>
                <CopyableValue value={status.hubUrl} testId="local-machine-hub-url" />
                {status.role === 'node' && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={leave.busy}
                    onClick={() =>
                      setLeaveRequest({
                        kind: 'change-hub',
                        from: 'node',
                        target: 'node',
                        intent: 'join-hub',
                      })
                    }
                    data-testid="local-machine-change-hub"
                  >
                    <Repeat />
                    {t('nodes.membership.changeHub')}
                  </Button>
                )}
              </Row>
            )}
            {status.hubPublicUrl && (
              <Row label={t('nodes.machine.hubPublicUrl')}>
                <CopyableValue value={status.hubPublicUrl} testId="local-machine-hub-public-url" />
              </Row>
            )}

            <DirectSection
              direct={direct}
              busy={busy}
              pending={mutations.pending}
              error={directError}
              onInstall={() => {
                setDirectError(null);
                mutations.run('install');
              }}
              onRemove={mutations.requestRemove}
              onToggle={(next) => {
                setDirectError(null);
                mutations.run(next ? 'enable' : 'disable');
              }}
            />

            {restartRequired && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2 text-xs"
                data-testid="local-machine-restart-required"
              >
                <span className="text-muted-foreground">
                  {restart.state === 'waiting'
                    ? t('nodes.machine.restarting')
                    : restart.state === 'timeout'
                      ? t('nodes.machine.restartTimeout')
                      : t('nodes.machine.directRestartRequired')}
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
        request={leaveRequest}
        leave={leave}
        onConfirm={() => {
          if (leaveRequest) leave.run({ from: leaveRequest.from, intent: leaveRequest.intent });
        }}
        onCancel={() => {
          setLeaveRequest(null);
          leave.reset();
        }}
      />
      {leave.dialog}
    </Card>
  );
}

function DirectSection({
  direct,
  busy,
  pending,
  error,
  onInstall,
  onRemove,
  onToggle,
}: {
  direct: LocalDirectStatus;
  busy: boolean;
  pending: LocalDirectAction | null;
  error: string | null;
  onInstall: () => void;
  onRemove: () => void;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const { supported, installed, enabled, capable, version } = direct;
  return (
    <>
      <Row label={t('nodes.machine.direct')}>
        <div className="flex flex-wrap items-center gap-2">
          {supported ? (
            <>
              <Badge variant="outline" data-testid="local-machine-direct-supported">
                {t('nodes.machine.directSupported')}
              </Badge>
              <Badge variant="outline" data-testid="local-machine-direct-installed">
                {installed
                  ? version
                    ? t('nodes.machine.directInstalledVersion', { version })
                    : t('nodes.machine.directInstalled')
                  : t('nodes.machine.directNotInstalled')}
              </Badge>
              {installed && capable && (
                <Badge variant="outline" data-testid="local-machine-direct-active">
                  {t('nodes.machine.directActive')}
                </Badge>
              )}
              {installed && !enabled && (
                <Badge variant="outline" data-testid="local-machine-direct-disabled">
                  {t('nodes.machine.directDisabled')}
                </Badge>
              )}
            </>
          ) : (
            <Badge variant="outline" data-testid="local-machine-direct-unsupported">
              {t('nodes.machine.directUnsupported')}
            </Badge>
          )}
          {installed ? (
            <Button
              type="button"
              size="xs"
              variant="destructive"
              disabled={!supported || busy}
              onClick={onRemove}
              data-testid="local-machine-direct-remove"
            >
              {pending === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('nodes.machine.directRemove')}
            </Button>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!supported || busy}
              onClick={onInstall}
              data-testid="local-machine-direct-install"
            >
              {pending === 'install' ? <Loader2 className="animate-spin" /> : <Download />}
              {t('nodes.machine.directInstall')}
            </Button>
          )}
        </div>
      </Row>

      <Row label={t('nodes.machine.directSwitch')}>
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={installed && enabled}
            disabled={!supported || !installed || busy}
            onCheckedChange={(checked) => onToggle(Boolean(checked))}
            data-testid="local-machine-direct-switch"
          />
          {supported && !installed && (
            <span className="text-xs text-muted-foreground" data-testid="local-machine-direct-hint">
              {t('nodes.machine.directSwitchHint')}
            </span>
          )}
        </div>
      </Row>

      {error && (
        <p className="text-xs text-destructive" data-testid="local-machine-direct-error">
          {error}
        </p>
      )}
    </>
  );
}

function RemoveConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="local-machine-direct-remove-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.machine.directRemoveConfirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('nodes.machine.directRemoveConfirm.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onCancel}
            data-testid="local-machine-direct-remove-confirm-cancel"
          >
            {t('nodes.machine.directRemoveConfirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            data-testid="local-machine-direct-remove-confirm-ok"
          >
            {t('nodes.machine.directRemoveConfirm.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function CopyableValue({ value, testId }: { value: string; testId: string }) {
  const { copied, copy } = useCopyToClipboard(value);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code
        className="min-w-0 break-all rounded bg-muted/50 px-1.5 py-0.5 text-[11px]"
        data-testid={testId}
      >
        {value}
      </code>
      <Button type="button" size="xs" variant="ghost" onClick={copy} data-testid={`${testId}-copy`}>
        {copied ? <Check className="tmex-scale-in" /> : <Copy className="tmex-scale-in" />}
        <CopyLabel copied={copied} />
      </Button>
    </span>
  );
}
