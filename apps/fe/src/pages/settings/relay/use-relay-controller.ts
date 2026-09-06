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
import { useState } from 'react';
import { toast } from 'sonner';
import { type UseRelayAdminResult, useRelayAdmin } from './relay-status-store';
import { type RelayAction, useRelayAction } from './use-relay-action';

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
  refresh: () => void
): OperatorDialogs {
  const password = useRelayAction();
  const quota = useRelayAction();
  const limits = useRelayAction();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);

  const submitPassword = async (body: RelayPasswordRequest) => {
    if (await password.run(() => api.setPassword(body))) {
      setPasswordOpen(false);
      toast.success(t('relay.admin.password.saved'));
      refresh();
    }
  };

  const submitDefaultQuota = async (next: RelayQuota) => {
    if (await quota.run(() => api.updateDefaultQuota(next))) {
      setQuotaOpen(false);
      toast.success(t('relay.admin.quota.saved'));
      refresh();
    }
  };

  const submitLimits = async (next: RelayLimits) => {
    if (await limits.run(() => api.updateLimits(next))) {
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
  const operator = useOperatorDialogs(api, t, refresh);

  const [editing, setEditing] = useState<RelayTenantSummary | null>(null);
  const [kicking, setKicking] = useState<RelayTenantSummary | null>(null);
  const [removing, setRemoving] = useState<RelayTenantSummary | null>(null);
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);

  const runTenant = async (id: string, task: () => Promise<void>): Promise<boolean> => {
    setBusyTenantId(id);
    const ok = await tenant.run(task);
    setBusyTenantId(null);
    if (ok) refresh();
    return ok;
  };

  const submitTenant = async (patch: RelayTenantPatch) => {
    if (!editing) return;
    if (await runTenant(editing.id, () => api.updateTenant(editing.id, patch))) {
      setEditing(null);
      toast.success(t('relay.admin.tenants.saved'));
    }
  };

  // 就地改备注没有自己的容身之处摆错误，成败一律走 toast。
  const saveLabel = async (row: RelayTenantSummary, label: string | null) => {
    if (await runTenant(row.id, () => api.updateTenant(row.id, { label }))) {
      toast.success(t('relay.admin.tenants.saved'));
    } else {
      toast.error(t('relay.admin.tenants.failed', { message: tenant.error ?? '' }));
    }
  };

  const confirmKick = async () => {
    if (!kicking) return;
    const ok = await runTenant(kicking.id, () => api.kickTenant(kicking.id));
    setKicking(null);
    if (ok) toast.success(t('relay.admin.tenants.kickDone'));
    else toast.error(t('relay.admin.tenants.kickFailed', { message: tenant.error ?? '' }));
  };

  const confirmRemove = async () => {
    if (!removing) return;
    if (await runTenant(removing.id, () => api.deleteTenant(removing.id))) {
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
  };
}
