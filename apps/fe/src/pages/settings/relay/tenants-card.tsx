// 租户卡：租户表 + 卡头的「更多」（默认配额）。选中的租户由上层持有，表只负责回传点击。

import type { RelayStatusResponse } from '@tmex/api-client/relay/admin-api';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { useTranslation } from 'react-i18next';
import { TenantsMenu } from './relay-menus';
import { TenantTable } from './tenant-table';
import type { RelayController } from './use-relay-controller';

export interface TenantsCardProps {
  controller: RelayController;
  status: RelayStatusResponse;
  /** 相对时间的基准，由调用方按刷新节奏推进。 */
  now: number;
  selectedTenantId: string | null;
  onSelectTenant: (id: string) => void;
  onClearSelection: () => void;
}

export function TenantsCard({
  controller,
  status,
  now,
  selectedTenantId,
  onSelectTenant,
  onClearSelection,
}: TenantsCardProps) {
  const { t } = useTranslation();
  return (
    <Card data-testid="relay-tenants-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle>{t('relay.admin.tenants.title')}</CardTitle>
          <span className="text-xs text-muted-foreground" data-testid="relay-tenants-total">
            {t('relay.admin.tenants.total', { n: status.tenants.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {selectedTenantId !== null && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={onClearSelection}
              data-testid="relay-tenants-clear-selection"
            >
              {t('relay.admin.tenants.clearSelection')}
            </Button>
          )}
          <TenantsMenu onDefaultQuota={controller.openQuota} />
        </div>
      </CardHeader>
      <CardContent>
        <TenantTable
          tenants={status.tenants}
          defaultQuota={status.config.defaultQuota}
          now={now}
          busyTenantId={controller.busyTenantId}
          selectedTenantId={selectedTenantId}
          onSelect={(tenant) => onSelectTenant(tenant.id)}
          onEdit={controller.openEditor}
          onKick={controller.openKick}
          onRemove={controller.openRemove}
          onSaveLabel={controller.saveLabel}
        />
      </CardContent>
    </Card>
  );
}
