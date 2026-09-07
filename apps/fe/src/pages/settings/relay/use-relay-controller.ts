// 「中继」标签的全部可变状态与写操作：四个对话框的开合、三条写路径的忙 / 错状态。
//
// 与渲染分开，是为了让标签组件本身只剩摆版式的部分（复杂度门禁按函数行数卡）。
// 每次写成功都重拉一次 status：中继端的配额、令牌代次与踢出状态互相牵连，回读比拼本地状态可靠。

import type {
  RelayAdminApi,
  RelayLimits,
  RelayPasswordRequest,
  RelayQuota,
  RelayTenantPatch,
  RelayTenantSummary,
} from '@vibeterm/api-client/relay/admin-api';
import { errorMessage } from '@vibeterm/shared';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { type RelayMembersOffline, classifyGuardedWrite } from './relay-offline-guard';
import { type UseRelayAdminResult, useRelayAdmin } from './relay-status-store';
import { type RelayAction, type RelayRunOutcome, useRelayAction } from './use-relay-action';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RelayController {
  relay: UseRelayAdminResult;
  password: RelayAction;
  quota: RelayAction;
  limits: RelayAction;
  tenant: RelayAction;
  passwordOpen: boolean;
  quotaOpen: boolean;
  limitsOpen: boolean;
  editing: RelayTenantSummary | null;
  kicking: RelayTenantSummary | null;
  removing: RelayTenantSummary | null;
  /** 正在写入的那一行；表里据此禁用该行动作。 */
  busyTenantId: string | null;
  openPassword: () => void;
  closePassword: () => void;
  openQuota: () => void;
  closeQuota: () => void;
  openLimits: () => void;
  closeLimits: () => void;
  openEditor: (tenant: RelayTenantSummary) => void;
  closeEditor: () => void;
  openKick: (tenant: RelayTenantSummary) => void;
  closeKick: () => void;
  openRemove: (tenant: RelayTenantSummary) => void;
  closeRemove: () => void;
  submitPassword: (body: RelayPasswordRequest) => void;
  submitDefaultQuota: (quota: RelayQuota) => void;
  submitLimits: (limits: RelayLimits) => void;
  submitTenant: (patch: RelayTenantPatch) => void;
  saveLabel: (tenant: RelayTenantSummary, label: string | null) => void;
  confirmKick: () => void;
  confirmRemove: () => void;
  /** 服务端拦下的「还有成员离线」二次确认；为 `null` 时不摆框。 */
  offlineGuard: RelayOfflineGuard | null;
  /** 认下后果，带 `force` 重发这次写入。 */
  confirmOfflineGuard: () => void;
  dismissOfflineGuard: () => void;
}

/** 待二次确认的破坏性写入：是哪一种，以及服务端数出来的人数。 */
export interface RelayOfflineGuard extends RelayMembersOffline {
  kind: 'password' | 'kick';
}

interface OfflineGuardHandle {
  request: RelayOfflineGuard | null;
  /** 记下这次被拦的写入与它的重发方式。 */
  hold: (request: RelayOfflineGuard, retry: () => Promise<void>) => void;
  confirm: () => void;
  dismiss: () => void;
}

/**
 * 二次确认的状态机。重发闭包与请求一起存：`force` 重发的必须是**被拦下的那一次**的参数，
 * 改密对话框此时可能已经被用户改动过。
 */
function useOfflineGuard(): OfflineGuardHandle {
  const [held, setHeld] = useState<{
    request: RelayOfflineGuard;
    retry: () => Promise<void>;
  } | null>(null);
  const dismiss = useCallback(() => setHeld(null), []);
  const confirm = useCallback(() => {
    if (!held) return;
    setHeld(null);
    void held.retry();
  }, [held]);
  return {
    request: held?.request ?? null,
    hold: (request, retry) => setHeld({ request, retry }),
    confirm,
    dismiss,
  };
}

type OperatorDialogs = Pick<
  RelayController,
  | 'password'
  | 'quota'
  | 'limits'
  | 'passwordOpen'
  | 'quotaOpen'
  | 'limitsOpen'
  | 'openPassword'
  | 'closePassword'
  | 'openQuota'
  | 'closeQuota'
  | 'openLimits'
  | 'closeLimits'
  | 'submitPassword'
  | 'submitDefaultQuota'
  | 'submitLimits'
>;

/** 三个只作用于中继本身的对话框（口令 / 默认配额 / 中继限额）：开合、忙错状态与写路径。 */
function useOperatorDialogs(
  api: RelayAdminApi,
  t: Translate,
  refresh: () => void,
  guard: OfflineGuardHandle
): OperatorDialogs {
  const password = useRelayAction();
  const quota = useRelayAction();
  const limits = useRelayAction();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);

  // `force` 只在用户看过「离线成员会被永久踢出」那一屏之后才带上。
  const submitPassword = async (body: RelayPasswordRequest, force = false) => {
    const request = force ? { ...body, force: true } : body;
    const outcome = classifyGuardedWrite(await password.run(() => api.setPassword(request)));
    if (outcome.kind === 'done') {
      setPasswordOpen(false);
      toast.success(t('relay.admin.password.saved'));
      refresh();
      return;
    }
    if (outcome.kind !== 'guard') return;
    // 对话框里那句「relay_members_offline」没有意义，后果改由二次确认框讲清楚。
    password.reset();
    guard.hold({ kind: 'password', ...outcome.offline }, () => submitPassword(body, true));
  };

  const submitDefaultQuota = async (next: RelayQuota) => {
    if ((await quota.run(() => api.updateDefaultQuota(next))).ok) {
      setQuotaOpen(false);
      toast.success(t('relay.admin.quota.saved'));
      refresh();
    }
  };

  const submitLimits = async (next: RelayLimits) => {
    if ((await limits.run(() => api.updateLimits(next))).ok) {
      setLimitsOpen(false);
      toast.success(t('relay.admin.limits.saved'));
      refresh();
    }
  };

  return {
    password,
    quota,
    limits,
    passwordOpen,
    quotaOpen,
    limitsOpen,
    openPassword: () => setPasswordOpen(true),
    closePassword: () => {
      setPasswordOpen(false);
      password.reset();
    },
    openQuota: () => setQuotaOpen(true),
    closeQuota: () => {
      setQuotaOpen(false);
      quota.reset();
    },
    openLimits: () => setLimitsOpen(true),
    closeLimits: () => {
      setLimitsOpen(false);
      limits.reset();
    },
    submitPassword: (body) => void submitPassword(body),
    submitDefaultQuota: (next) => void submitDefaultQuota(next),
    submitLimits: (next) => void submitLimits(next),
  };
}

export function useRelayController(api: RelayAdminApi, t: Translate): RelayController {
  const relay = useRelayAdmin({ api, owner: true });
  const tenant = useRelayAction();
  const refresh = relay.refresh;
  const guard = useOfflineGuard();
  const operator = useOperatorDialogs(api, t, refresh, guard);

  const [editing, setEditing] = useState<RelayTenantSummary | null>(null);
  const [kicking, setKicking] = useState<RelayTenantSummary | null>(null);
  const [removing, setRemoving] = useState<RelayTenantSummary | null>(null);
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);

  const runTenant = async (id: string, task: () => Promise<void>): Promise<RelayRunOutcome> => {
    setBusyTenantId(id);
    const outcome = await tenant.run(task);
    setBusyTenantId(null);
    if (outcome.ok) refresh();
    return outcome;
  };

  const submitTenant = async (patch: RelayTenantPatch) => {
    if (!editing) return;
    if ((await runTenant(editing.id, () => api.updateTenant(editing.id, patch))).ok) {
      setEditing(null);
      toast.success(t('relay.admin.tenants.saved'));
    }
  };

  // 就地改备注没有自己的容身之处摆错误，成败一律走 toast。
  const saveLabel = async (row: RelayTenantSummary, label: string | null) => {
    const outcome = await runTenant(row.id, () => api.updateTenant(row.id, { label }));
    if (outcome.ok) toast.success(t('relay.admin.tenants.saved'));
    else toast.error(t('relay.admin.tenants.failed', { message: errorMessage(outcome.error) }));
  };

  const kickTenant = async (row: RelayTenantSummary, force: boolean) => {
    const outcome = classifyGuardedWrite(
      await runTenant(row.id, () => api.kickTenant(row.id, force ? { force: true } : undefined))
    );
    setKicking(null);
    if (outcome.kind === 'done') {
      toast.success(t('relay.admin.tenants.kickDone'));
      return;
    }
    if (outcome.kind === 'guard') {
      guard.hold({ kind: 'kick', ...outcome.offline }, () => kickTenant(row, true));
      return;
    }
    toast.error(t('relay.admin.tenants.kickFailed', { message: errorMessage(outcome.error) }));
  };

  const confirmKick = async () => {
    if (kicking) await kickTenant(kicking, false);
  };

  const confirmRemove = async () => {
    if (!removing) return;
    if ((await runTenant(removing.id, () => api.deleteTenant(removing.id))).ok) {
      setRemoving(null);
      toast.success(t('relay.admin.tenants.removeDone'));
    }
  };

  return {
    ...operator,
    relay,
    tenant,
    editing,
    kicking,
    removing,
    busyTenantId,
    openEditor: setEditing,
    closeEditor: () => {
      setEditing(null);
      tenant.reset();
    },
    openKick: setKicking,
    closeKick: () => setKicking(null),
    openRemove: setRemoving,
    closeRemove: () => {
      setRemoving(null);
      tenant.reset();
    },
    submitTenant: (patch) => void submitTenant(patch),
    saveLabel: (row, label) => void saveLabel(row, label),
    confirmKick: () => void confirmKick(),
    confirmRemove: () => void confirmRemove(),
    offlineGuard: guard.request,
    confirmOfflineGuard: guard.confirm,
    dismissOfflineGuard: guard.dismiss,
  };
}
