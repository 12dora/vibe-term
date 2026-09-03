// 租户表：一行一租户，编辑 / 踢出 / 删除三个动作。备注可在表里就地改，其余改动进编辑框。

import type { RelayQuota, RelayTenantSummary } from '@tmex/api-client/relay/admin-api';
import { cn } from '@tmex/ui';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Pencil, Trash2, Unplug } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WideTableScroll, stickyActionColumn } from '../components/wide-table';
import { CopyButton } from '../nodes/copy-feedback';
import {
  epochText,
  quotaSummary,
  relativeTimeText,
  shortTenantId,
  trafficText,
} from './relay-format';

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
}

export function TenantTable(props: TenantTableProps) {
  const { t } = useTranslation();
  const { tenants } = props;
  return (
    <WideTableScroll>
      <table className="w-full min-w-[62rem] text-xs" data-testid="relay-tenants-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('relay.admin.tenants.columns.id')}</Th>
            <Th>{t('relay.admin.tenants.columns.label')}</Th>
            <Th>{t('relay.admin.tenants.columns.created')}</Th>
            <Th>{t('relay.admin.tenants.columns.lastSeen')}</Th>
            <Th>{t('relay.admin.tenants.columns.nodes')}</Th>
            <Th>{t('relay.admin.tenants.columns.streams')}</Th>
            <Th>{t('relay.admin.tenants.columns.traffic')}</Th>
            <Th>{t('relay.admin.tenants.columns.quota')}</Th>
            <Th>{t('relay.admin.tenants.columns.tokenEpoch')}</Th>
            <Th className={stickyActionColumn}>{t('relay.admin.tenants.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <TenantRow key={tenant.id} tenant={tenant} {...props} />
          ))}
          {tenants.length === 0 && (
            <tr>
              <td colSpan={10} className="tmex-fade px-3 py-6 text-center text-muted-foreground">
                {t('relay.admin.tenants.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function TenantRow({
  tenant,
  defaultQuota,
  now,
  busyTenantId,
  onEdit,
  onKick,
  onRemove,
  onSaveLabel,
}: { tenant: RelayTenantSummary } & TenantTableProps) {
  const { t } = useTranslation();
  const quota = quotaSummary(t, tenant.quota, defaultQuota);
  const busy = busyTenantId === tenant.id;

  return (
    <tr
      className="border-b border-border/60 last:border-0"
      data-testid={`relay-tenant-row-${tenant.id}`}
    >
      <Td>
        <span className="flex items-center gap-1">
          <code className="font-mono text-[11px]" title={tenant.id}>
            {shortTenantId(tenant.id)}
          </code>
          <CopyButton value={tenant.id} testId={`relay-tenant-${tenant.id}`} />
        </span>
      </Td>
      <Td>
        <TenantLabelCell tenant={tenant} busy={busy} onSave={onSaveLabel} />
      </Td>
      <Td>{relativeTimeText(t, tenant.createdAt, now)}</Td>
      <Td>{relativeTimeText(t, tenant.lastSeenAt, now)}</Td>
      <Td>
        <span className="flex items-center gap-1">
          <span data-testid={`relay-tenant-nodes-${tenant.id}`}>
            {t('relay.admin.tenants.nodesValue', {
              online: tenant.nodesOnline,
              total: tenant.nodes,
            })}
          </span>
          {tenant.nodesRevoked > 0 && (
            <span
              className="text-muted-foreground"
              data-testid={`relay-tenant-nodes-revoked-${tenant.id}`}
            >
              {t('relay.admin.tenants.nodesRevoked', { count: tenant.nodesRevoked })}
            </span>
          )}
        </span>
      </Td>
      <Td>{tenant.streams}</Td>
      <Td>
        <span data-testid={`relay-tenant-traffic-${tenant.id}`}>
          {trafficText(tenant.bytesOut)}
        </span>
      </Td>
      <Td>
        <span className="flex items-center gap-1">
          <span data-testid={`relay-tenant-quota-${tenant.id}`}>{quota.text}</span>
          {quota.inherited && (
            <Badge variant="outline" data-testid={`relay-tenant-quota-default-${tenant.id}`}>
              {t('relay.admin.quota.inheritBadge')}
            </Badge>
          )}
        </span>
      </Td>
      <Td>
        <span className="flex items-center gap-1">
          {epochText(t, tenant.tokenEpoch)}
          {tenant.kicked && (
            <Badge variant="destructive" data-testid={`relay-tenant-kicked-${tenant.id}`}>
              {t('relay.admin.tenants.kicked')}
            </Badge>
          )}
        </span>
      </Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onEdit(tenant)}
            data-testid={`relay-tenant-edit-${tenant.id}`}
          >
            <Pencil />
            {t('relay.admin.tenants.edit')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => onKick(tenant)}
            data-testid={`relay-tenant-kick-${tenant.id}`}
          >
            <Unplug />
            {t('relay.admin.tenants.kick')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => onRemove(tenant)}
            data-testid={`relay-tenant-remove-${tenant.id}`}
          >
            <Trash2 />
            {t('relay.admin.tenants.remove')}
          </Button>
        </div>
      </Td>
    </tr>
  );
}

/** 备注就地编辑：点一下变输入框，回车或失焦提交，Esc 放弃。 */
function TenantLabelCell({
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

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap px-3 py-2 text-left font-medium', className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('whitespace-nowrap px-3 py-2 align-middle', className)}>{children}</td>;
}
