// 接入节点卡：检索 / 状态过滤 / 列排序都在这里收口，表格本身只摆版式。
// 选中租户时只留该租户的节点，卡头把范围写明白。

import type { RelayTenantSummary } from '@tmex/api-client/relay/admin-api';
import type { RelayMetricsMember } from '@tmex/api-client/relay/metrics-types';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Search, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shortTenantId } from './relay-format';
import { RelayMembersTable } from './relay-metrics-members';
import {
  DEFAULT_MEMBER_SORT,
  type MemberSort,
  type MemberSortKey,
  type MemberStateFilter,
  filterMembers,
  sortMembersBy,
  toggleMemberSort,
} from './relay-metrics-model';

const STATE_FILTERS: MemberStateFilter[] = ['all', 'online', 'offline'];

const STATE_FILTER_KEY: Record<MemberStateFilter, string> = {
  all: 'relay.metrics.members.all',
  online: 'relay.metrics.members.online',
  offline: 'relay.metrics.members.offline',
};

export function tenantScopeLabel(tenant: RelayTenantSummary): string {
  return tenant.label?.trim() || shortTenantId(tenant.id);
}

/** 状态过滤的分段按钮。三档很少，摆成分段比藏进下拉少一次点击。 */
export function MemberStateFilterGroup({
  value,
  onChange,
}: {
  value: MemberStateFilter;
  onChange: (next: MemberStateFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5"
      aria-label={t('relay.metrics.members.stateFilter')}
      data-testid="relay-members-state-filter"
    >
      {STATE_FILTERS.map((state) => (
        <Button
          key={state}
          type="button"
          size="xs"
          variant={value === state ? 'secondary' : 'ghost'}
          aria-pressed={value === state}
          onClick={() => onChange(state)}
          data-testid={`relay-members-filter-${state}`}
        >
          {t(STATE_FILTER_KEY[state])}
        </Button>
      ))}
    </fieldset>
  );
}

export interface RelayMembersCardProps {
  members: RelayMetricsMember[];
  /** 相对时间的基准，由调用方按刷新节奏推进。 */
  now: number;
  /** 选中的租户；`null` 即摆全部节点。 */
  tenant: RelayTenantSummary | null;
  onClearTenant: () => void;
}

export function RelayMembersCard({ members, now, tenant, onClearTenant }: RelayMembersCardProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<MemberStateFilter>('all');
  const [sort, setSort] = useState<MemberSort>(DEFAULT_MEMBER_SORT);

  const filter = { query, state, tenantId: tenant?.id ?? null };
  const rows = sortMembersBy(filterMembers(members, filter), sort);
  const filtered = members.length > 0 && rows.length === 0;

  return (
    <Card data-testid="relay-members-card">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle>{t('relay.metrics.members.title')}</CardTitle>
          <span className="text-xs text-muted-foreground" data-testid="relay-members-total">
            {t('relay.metrics.members.total', { n: rows.length })}
          </span>
          {tenant && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onClearTenant}
              title={t('relay.admin.tenants.clearSelection')}
              data-testid="relay-members-tenant-scope"
            >
              {tenantScopeLabel(tenant)}
              <X />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="h-7 w-44 pl-7 text-xs"
              value={query}
              placeholder={t('relay.metrics.members.searchPlaceholder')}
              aria-label={t('relay.metrics.members.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              data-testid="relay-members-search"
            />
          </div>
          <MemberStateFilterGroup value={state} onChange={setState} />
        </div>
      </CardHeader>
      <CardContent>
        <RelayMembersTable
          members={rows}
          now={now}
          sort={sort}
          filtered={filtered}
          onSort={(key: MemberSortKey) => setSort((prev) => toggleMemberSort(prev, key))}
        />
      </CardContent>
    </Card>
  );
}
