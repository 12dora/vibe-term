// 「中继」标签的全部可变状态与写操作：四个对话框的开合、三条写路径的忙 / 错状态。
//
// 与渲染分开，是为了让标签组件本身只剩摆版式的部分（复杂度门禁按函数行数卡）。
// 每次写成功都重拉一次 status：中继端的配额、令牌代次与踢出状态互相牵连，回读比拼本地状态可靠。

import type {
  RelayAdminApi,
  RelayPasswordRequest,
  RelayQuota,
  RelayTenantPatch,
  RelayTenantSummary,
} from '@tmex/api-client/relay/admin-api';
import { useState } from 'react';
import { toast } from 'sonner';
import { type UseRelayAdminResult, useRelayAdmin } from './relay-status-store';
import { type RelayAction, useRelayAction } from './use-relay-action';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RelayController {
  relay: UseRelayAdminResult;
  password: RelayAction;
  quota: RelayAction;
  tenant: RelayAction;
  passwordOpen: boolean;
  editing: RelayTenantSummary | null;
  kicking: RelayTenantSummary | null;
  removing: RelayTenantSummary | null;
  /** 正在写入的那一行；表里据此禁用该行动作。 */
  busyTenantId: string | null;
  openPassword: () => void;
  closePassword: () => void;
  openEditor: (tenant: RelayTenantSummary) => void;
  closeEditor: () => void;
  openKick: (tenant: RelayTenantSummary) => void;
  closeKick: () => void;
  openRemove: (tenant: RelayTenantSummary) => void;
  closeRemove: () => void;
  submitPassword: (body: RelayPasswordRequest) => void;
  submitDefaultQuota: (quota: RelayQuota) => void;
  submitTenant: (patch: RelayTenantPatch) => void;
  saveLabel: (tenant: RelayTenantSummary, label: string | null) => void;
  confirmKick: () => void;
  confirmRemove: () => void;
}

export function useRelayController(api: RelayAdminApi, t: Translate): RelayController {
  const relay = useRelayAdmin({ api, owner: true });
  const password = useRelayAction();
  const quota = useRelayAction();
  const tenant = useRelayAction();

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [editing, setEditing] = useState<RelayTenantSummary | null>(null);
  const [kicking, setKicking] = useState<RelayTenantSummary | null>(null);
  const [removing, setRemoving] = useState<RelayTenantSummary | null>(null);
  const [busyTenantId, setBusyTenantId] = useState<string | null>(null);

  const refresh = relay.refresh;

  const runTenant = async (id: string, task: () => Promise<void>): Promise<boolean> => {
    setBusyTenantId(id);
    const ok = await tenant.run(task);
    setBusyTenantId(null);
    if (ok) refresh();
    return ok;
  };

  const submitPassword = async (body: RelayPasswordRequest) => {
    if (await password.run(() => api.setPassword(body))) {
      setPasswordOpen(false);
      toast.success(t('relay.admin.password.saved'));
      refresh();
    }
  };

  const submitDefaultQuota = async (next: RelayQuota) => {
    if (await quota.run(() => api.updateDefaultQuota(next))) {
      toast.success(t('relay.admin.quota.saved'));
      refresh();
    }
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
    relay,
    password,
    quota,
    tenant,
    passwordOpen,
    editing,
    kicking,
    removing,
    busyTenantId,
    openPassword: () => setPasswordOpen(true),
    closePassword: () => {
      setPasswordOpen(false);
      password.reset();
    },
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
    submitPassword: (body) => void submitPassword(body),
    submitDefaultQuota: (next) => void submitDefaultQuota(next),
    submitTenant: (patch) => void submitTenant(patch),
    saveLabel: (row, label) => void saveLabel(row, label),
    confirmKick: () => void confirmKick(),
    confirmRemove: () => void confirmRemove(),
  };
}
