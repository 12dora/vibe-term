// 租户表在 sm 以下的版式：一个租户一张记录卡。
//
// 表有十列（编号 / 备注 / 接入 / 最近在线 / 节点 / 流 / 流量 / 配额 / 纪元 / 操作），390px 下
// 只能横滚着看，编号那一列还被硬截。卡片摊成：标题行（短编号 + 复制 + ⋯）、备注、两条弱化
// 信息行；三个动作收进 ⋯ 菜单，testid 与表里那三枚按钮一致。点卡片仍然筛选下方的接入节点。

import {
  RecordCard,
  RecordCardEmpty,
  RecordCardFacts,
  RecordCardList,
} from '@/components/record-card';
import type { RelayQuota, RelayTenantSummary } from '@vibeterm/api-client/relay/admin-api';
import { Badge } from '@vibeterm/ui/badge';
import { Button } from '@vibeterm/ui/button';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Ellipsis, Pencil, Trash2, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../nodes/copy-feedback';
import {
  epochText,
  quotaSummary,
  relativeTimeText,
  shortTenantId,
  trafficText,
} from './relay-format';
import { TenantLabelCell, type TenantTableProps } from './tenant-row-parts';

export function TenantCardList(props: TenantTableProps) {
  const { t } = useTranslation();
  const { tenants } = props;
  return (
    <RecordCardList testId="relay-tenants-table">
      {tenants.map((tenant) => (
        <TenantCard key={tenant.id} tenant={tenant} {...props} />
      ))}
      {tenants.length === 0 && <RecordCardEmpty>{t('relay.admin.tenants.empty')}</RecordCardEmpty>}
    </RecordCardList>
  );
}

function TenantCard({
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

  return (
    <RecordCard
      testId={`relay-tenant-row-${tenant.id}`}
      selection={{
        selected: selectedTenantId === tenant.id,
        hint: t('relay.admin.tenants.selectHint'),
        onSelect: () => onSelect(tenant),
      }}
    >
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px]" title={tenant.id}>
          {shortTenantId(tenant.id)}
        </code>
        <CopyButton value={tenant.id} testId={`relay-tenant-${tenant.id}`} />
        <TenantCardMenu
          tenant={tenant}
          busy={busy}
          onEdit={onEdit}
          onKick={onKick}
          onRemove={onRemove}
        />
      </div>

      <div className="flex items-center gap-1">
        <TenantLabelCell tenant={tenant} busy={busy} onSave={onSaveLabel} />
      </div>

      <RecordCardFacts label={t('relay.admin.tenants.columns.created')}>
        <span>{relativeTimeText(t, tenant.createdAt, now)}</span>
        <span>
          {t('relay.admin.tenants.columns.lastSeen')} {relativeTimeText(t, tenant.lastSeenAt, now)}
        </span>
        {/* 令牌纪元平时是实现细节，只有这户被踢过才值得占一段。 */}
        {tenant.kicked && (
          <span className="flex items-center gap-1">
            {epochText(t, tenant.tokenEpoch)}
            <Badge variant="destructive" data-testid={`relay-tenant-kicked-${tenant.id}`}>
              {t('relay.admin.tenants.kicked')}
            </Badge>
          </span>
        )}
      </RecordCardFacts>

      <TenantCardUsage tenant={tenant} defaultQuota={defaultQuota} />
    </RecordCard>
  );
}

/**
 * 用量与配额各占一行：五段挤成一行会在 390px 折行，折出来的半句还得从一个 `·` 开头。
 * `ByteRate` 的定宽是给表格列防抖动用的，这里读数右边没有东西会被推走，取消掉。
 */
function TenantCardUsage({
  tenant,
  defaultQuota,
}: { tenant: RelayTenantSummary; defaultQuota: RelayQuota }) {
  const { t } = useTranslation();
  const quota = quotaSummary(t, tenant.quota, defaultQuota);
  return (
    <>
      <RecordCardFacts label={t('relay.admin.tenants.mobile.usage')}>
        <span data-testid={`relay-tenant-nodes-${tenant.id}`}>
          {t('relay.admin.tenants.columns.nodes')}{' '}
          {t('relay.admin.tenants.nodesValue', { online: tenant.nodesOnline, total: tenant.nodes })}
          {tenant.nodesRevoked > 0 && (
            <span data-testid={`relay-tenant-nodes-revoked-${tenant.id}`}>
              {' '}
              {t('relay.admin.tenants.nodesRevoked', { count: tenant.nodesRevoked })}
            </span>
          )}
        </span>
        <span>
          {t('relay.admin.tenants.columns.streams')} {tenant.streams}
        </span>
        <ByteRate
          align="left"
          minWidthClass="min-w-0"
          data-testid={`relay-tenant-traffic-${tenant.id}`}
        >
          {trafficText(tenant.bytesOut)}
        </ByteRate>
      </RecordCardFacts>

      <RecordCardFacts label={t('relay.admin.tenants.columns.quota')}>
        <span className="flex items-center gap-1">
          <span data-testid={`relay-tenant-quota-${tenant.id}`}>{quota.text}</span>
          {quota.inherited && (
            <Badge variant="outline" data-testid={`relay-tenant-quota-default-${tenant.id}`}>
              {t('relay.admin.quota.inheritBadge')}
            </Badge>
          )}
        </span>
      </RecordCardFacts>
    </>
  );
}

/** 三个动作收进 ⋯：卡片这么窄，三枚并排的按钮会把标题行挤没。 */
function TenantCardMenu({
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={t('relay.admin.more')}
            title={t('relay.admin.more')}
            data-testid={`relay-tenant-menu-${tenant.id}`}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem
          onClick={() => onEdit(tenant)}
          data-testid={`relay-tenant-edit-${tenant.id}`}
        >
          <Pencil className="size-4" />
          {t('relay.admin.tenants.edit')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onKick(tenant)}
          data-testid={`relay-tenant-kick-${tenant.id}`}
        >
          <Unplug className="size-4" />
          {t('relay.admin.tenants.kick')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onRemove(tenant)}
          data-testid={`relay-tenant-remove-${tenant.id}`}
        >
          <Trash2 className="size-4" />
          {t('relay.admin.tenants.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
