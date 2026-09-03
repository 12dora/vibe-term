// 设置页「中继」标签：中继运营者视角的健康 / 总量 / 口令 / 默认配额 / 租户表。
//
// 只有本机带 `relay` 角色时这个标签才存在（门禁见 relay-status-store 与 SettingsPage）；
// 直接敲 `?tab=relay` 进来的话，这里照样给出「未启用」的说明，而不是空白页。
// 状态与写操作全在 `useRelayController` 里，本文件只摆版式。

import type { RelayAdminApi, RelayStatusResponse } from '@tmex/api-client/relay/admin-api';
import { defaultRelayAdminApi } from '@tmex/api-client/relay/admin-api';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { DefaultQuotaCard } from './default-quota-card';
import { PasswordDialog } from './password-dialog';
import { RelayHealthCard, RelayPasswordCard, RelayTotalsCard } from './relay-cards';
import { DeleteTenantConfirm, KickTenantConfirm } from './tenant-confirms';
import { TenantEditorDialog } from './tenant-editor-dialog';
import { TenantTable } from './tenant-table';
import { type RelayController, useRelayController } from './use-relay-controller';

export interface RelayTabProps {
  api?: RelayAdminApi;
}

export function RelayTab({ api = defaultRelayAdminApi }: RelayTabProps = {}) {
  const { t } = useTranslation();
  const controller = useRelayController(api, t);
  const { relay } = controller;

  if (relay.availability === 'unavailable') {
    return (
      <RelayShell testId="settings-relay-tab-unavailable">
        <Notice tone="info" testId="relay-unavailable">
          <p>{t('relay.admin.unavailable')}</p>
          <p>{t('relay.admin.unavailableHint')}</p>
        </Notice>
      </RelayShell>
    );
  }

  if (relay.availability === 'unauthorized') {
    return (
      <RelayShell testId="settings-relay-tab-login">
        <Notice tone="warning" testId="relay-login-required">
          {t('relay.admin.loginRequired')}
        </Notice>
      </RelayShell>
    );
  }

  if (relay.status === null) {
    if (!relay.error) return <RelayTabSkeleton />;
    return (
      <RelayShell testId="settings-relay-tab-error">
        <Notice tone="error" testId="relay-load-error">
          {t('relay.admin.loadFailed', { message: relay.error })}
        </Notice>
        <div>
          <Button variant="outline" onClick={relay.refresh} data-testid="relay-retry">
            {t('common.retry')}
          </Button>
        </div>
      </RelayShell>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-relay-tab">
      <RelayTabHeader controller={controller} />
      <RelayTabBody controller={controller} status={relay.status} />
      <RelayTabDialogs controller={controller} status={relay.status} />
    </div>
  );
}

function RelayTabHeader({ controller }: { controller: RelayController }) {
  const { t } = useTranslation();
  const { relay } = controller;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-medium">{t('relay.admin.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('relay.admin.description')}</p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={relay.loading}
          aria-label={t('common.refresh')}
          title={t('common.refresh')}
          onClick={relay.refresh}
          data-testid="relay-refresh"
        >
          <RefreshCw className={relay.loading ? 'animate-spin motion-reduce:animate-none' : ''} />
        </Button>
      </div>
      {relay.error && (
        <Notice tone="error" testId="relay-refresh-error">
          {t('relay.admin.loadFailed', { message: relay.error })}
        </Notice>
      )}
    </>
  );
}

function RelayTabBody({
  controller,
  status,
}: { controller: RelayController; status: RelayStatusResponse }) {
  const { t } = useTranslation();
  const { relay, quota } = controller;
  // 相对时间以「这份数据是什么时候拉到的」为基准：每一拍推进一次，中间不必逐秒重渲染。
  const now = relay.loadedAt ?? Date.now();

  return (
    <>
      <Reveal className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <RelayHealthCard health={relay.health} />
        <RelayTotalsCard totals={status.totals} />
        <RelayPasswordCard config={status.config} onChange={controller.openPassword} />
      </Reveal>

      <Reveal delayMs={60}>
        <DefaultQuotaCard
          quota={status.config.defaultQuota}
          busy={quota.busy}
          error={quota.error ? t('relay.admin.quota.failed', { message: quota.error }) : null}
          onSave={controller.submitDefaultQuota}
        />
      </Reveal>

      <Reveal delayMs={120}>
        <Card data-testid="relay-tenants-card">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>{t('relay.admin.tenants.title')}</CardTitle>
            <span className="text-xs text-muted-foreground" data-testid="relay-tenants-total">
              {t('relay.admin.tenants.total', { n: status.tenants.length })}
            </span>
          </CardHeader>
          <CardContent>
            <TenantTable
              tenants={status.tenants}
              defaultQuota={status.config.defaultQuota}
              now={now}
              busyTenantId={controller.busyTenantId}
              onEdit={controller.openEditor}
              onKick={controller.openKick}
              onRemove={controller.openRemove}
              onSaveLabel={controller.saveLabel}
            />
          </CardContent>
        </Card>
      </Reveal>
    </>
  );
}

function RelayTabDialogs({
  controller,
  status,
}: { controller: RelayController; status: RelayStatusResponse }) {
  const { t } = useTranslation();
  const { password, tenant } = controller;
  const tenantError = tenant.error;

  return (
    <>
      <PasswordDialog
        open={controller.passwordOpen}
        busy={password.busy}
        error={
          password.error ? t('relay.admin.password.failed', { message: password.error }) : null
        }
        onOpenChange={(next) => {
          if (next) controller.openPassword();
          else controller.closePassword();
        }}
        onSubmit={controller.submitPassword}
      />

      <TenantEditorDialog
        tenant={controller.editing}
        defaultQuota={status.config.defaultQuota}
        busy={tenant.busy}
        error={tenantError ? t('relay.admin.tenants.failed', { message: tenantError }) : null}
        onOpenChange={(next) => {
          if (!next) controller.closeEditor();
        }}
        onSubmit={controller.submitTenant}
      />

      <KickTenantConfirm
        tenantId={controller.kicking?.id ?? null}
        busy={tenant.busy}
        onCancel={controller.closeKick}
        onConfirm={controller.confirmKick}
      />

      <DeleteTenantConfirm
        key={controller.removing?.id ?? 'none'}
        tenantId={controller.removing?.id ?? null}
        busy={tenant.busy}
        error={tenantError ? t('relay.admin.tenants.removeFailed', { message: tenantError }) : null}
        onCancel={controller.closeRemove}
        onConfirm={controller.confirmRemove}
      />
    </>
  );
}

/** 「没有数据可摆」的三种收尾（未启用 / 未登录 / 加载失败）共用的外壳。 */
function RelayShell({ testId, children }: { testId: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-3" data-testid={testId}>
      <div>
        <h2 className="text-base font-medium">{t('relay.admin.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('relay.admin.description')}</p>
      </div>
      {children}
    </div>
  );
}

function RelayTabSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-relay-tab-skeleton">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <Skeleton className="h-44 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
