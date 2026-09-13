// 租户行的共用件：表格与记录卡都要用的 props 形状与「备注就地编辑」。

import type { RelayQuota, RelayTenantSummary } from '@vibeterm/api-client/relay/admin-api';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { type KeyboardEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface TenantTableProps {
  tenants: RelayTenantSummary[];
  defaultQuota: RelayQuota;
  /** 相对时间的基准；由调用方按刷新节奏推进，静态渲染时可注入定值。 */
  now: number;
  /** 正在写入的那一行：该行动作禁用。 */
  busyTenantId: string | null;
  onEdit: (tenant: RelayTenantSummary) => void;
  onKick: (tenant: RelayTenantSummary) => void;
  onRemove: (tenant: RelayTenantSummary) => void;
  onSaveLabel: (tenant: RelayTenantSummary, label: string | null) => void;
  /** 选中的租户；`null` 即没有筛选。 */
  selectedTenantId: string | null;
  onSelect: (tenant: RelayTenantSummary) => void;
}

/** 备注就地编辑：点一下变输入框，回车或失焦提交，Esc 放弃。 */
export function TenantLabelCell({
  tenant,
  busy,
  onSave,
}: {
  tenant: RelayTenantSummary;
  busy: boolean;
  onSave: (tenant: RelayTenantSummary, label: string | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(tenant.label ?? '');

  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next === (tenant.label ?? '')) return;
    onSave(tenant, next === '' ? null : next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') {
      setValue(tenant.label ?? '');
      setEditing(false);
    }
  };

  if (!editing) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy}
        className="max-w-40 justify-start truncate font-normal"
        onClick={() => {
          setValue(tenant.label ?? '');
          setEditing(true);
        }}
        data-testid={`relay-tenant-label-${tenant.id}`}
      >
        {tenant.label ?? (
          <span className="text-muted-foreground">{t('relay.admin.tenants.noLabel')}</span>
        )}
      </Button>
    );
  }

  return (
    <Input
      autoFocus
      className="h-7 max-w-40"
      value={value}
      disabled={busy}
      placeholder={t('relay.admin.tenants.labelPlaceholder')}
      aria-label={t('relay.admin.tenants.label')}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
      data-testid={`relay-tenant-label-input-${tenant.id}`}
    />
  );
}
