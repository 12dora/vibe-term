// 租户表：一行一租户，编辑 / 踢出 / 删除三个动作。备注可在表里就地改，其余改动进编辑框。
// 点行即选中，下方的接入节点卡只留该租户的节点；再点一次取消。

import { useNarrowLayout } from '@/components/use-narrow-layout';
import type { RelayQuota, RelayTenantSummary } from '@vibeterm/api-client/relay/admin-api';
import { cn } from '@vibeterm/ui';
import { Badge } from '@vibeterm/ui/badge';
import { Button } from '@vibeterm/ui/button';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import { Pencil, Trash2, Unplug } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
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
import { TenantCardList } from './tenant-card-list';
import { TenantLabelCell, type TenantTableProps } from './tenant-row-parts';

export type { TenantTableProps };

export function TenantTable(props: TenantTableProps) {
  const narrow = useNarrowLayout();
  if (narrow) return <TenantCardList {...props} />;
  return <TenantWideTable {...props} />;
}

function TenantWideTable(props: TenantTableProps) {
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
              <td
                colSpan={10}
                className="vibeterm-fade px-3 py-6 text-center text-muted-foreground"
              >
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
  selectedTenantId,
  onSelect,
}: { tenant: RelayTenantSummary } & TenantTableProps) {
  const { t } = useTranslation();
  const busy = busyTenantId === tenant.id;
  const selected = selectedTenantId === tenant.id;

  // 行内的控件（复制、备注编辑、三个动作）自成一体：点它们不该顺带切换选中。
  const onClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest('button, input, a')) return;
    onSelect(tenant);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(tenant);
  };

  return (
    <tr
      className={cn(
        'cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/40',
        selected && 'bg-primary/5 ring-1 ring-primary/40 ring-inset hover:bg-primary/5'
      )}
      aria-selected={selected}
      tabIndex={0}
      title={t('relay.admin.tenants.selectHint')}
      onClick={onClick}
      onKeyDown={onKeyDown}
      data-selected={selected ? '' : undefined}
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
      <TenantNodesCell tenant={tenant} />
      <Td>{tenant.streams}</Td>
      <Td>
        <ByteRate data-testid={`relay-tenant-traffic-${tenant.id}`}>
          {trafficText(tenant.bytesOut)}
        </ByteRate>
      </Td>
      <TenantQuotaCell tenant={tenant} defaultQuota={defaultQuota} />
      <TenantEpochCell tenant={tenant} />
      <TenantActionsCell
        tenant={tenant}
        busy={busy}
        onEdit={onEdit}
        onKick={onKick}
        onRemove={onRemove}
      />
    </tr>
  );
}

function TenantNodesCell({ tenant }: { tenant: RelayTenantSummary }) {
  const { t } = useTranslation();
  return (
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
  );
}

function TenantQuotaCell({
  tenant,
  defaultQuota,
}: { tenant: RelayTenantSummary; defaultQuota: RelayQuota }) {
  const { t } = useTranslation();
  const quota = quotaSummary(t, tenant.quota, defaultQuota);
  return (
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
  );
}

function TenantEpochCell({ tenant }: { tenant: RelayTenantSummary }) {
  const { t } = useTranslation();
  return (
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
  );
}

function TenantActionsCell({
  tenant,
  busy,
  onEdit,
  onKick,
  onRemove,
}: {
  tenant: RelayTenantSummary;
  busy: boolean;
  onEdit: (tenant: RelayTenantSummary) => void;
  onKick: (tenant: RelayTenantSummary) => void;
  onRemove: (tenant: RelayTenantSummary) => void;
}) {
  const { t } = useTranslation();
  return (
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
