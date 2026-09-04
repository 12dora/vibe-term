// 设置页「中继管理」标签：中继运营者视角的指标 / 租户 / 接入节点。
//
// 只有本机带 `relay` 角色时这个标签才存在（门禁见 relay-status-store 与 SettingsPage）；
// 直接敲 `?tab=relay` 进来的话，这里照样给出「未启用」的说明，而不是空白页。
// 状态与写操作全在 `useRelayController` 里，本文件只摆版式。

import type { RelayAdminApi, RelayStatusResponse } from '@tmex/api-client/relay/admin-api';
import { defaultRelayAdminApi } from '@tmex/api-client/relay/admin-api';
import { Button } from '@tmex/ui/button';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { DefaultQuotaDialog } from './default-quota-dialog';
import { RelayMembersCard } from './members-card';
import { PasswordDialog } from './password-dialog';
import { RelayAdminMenu } from './relay-menus';
import { RelayMetricsPanel } from './relay-metrics-panel';
import { useRelayMetrics } from './relay-metrics-store';
import { DeleteTenantConfirm, KickTenantConfirm } from './tenant-confirms';
import { TenantEditorDialog } from './tenant-editor-dialog';
import { TenantsCard } from './tenants-card';
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
      <RelayTabHeader controller={controller} status={relay.status} />
      <RelayTabBody controller={controller} status={relay.status} api={api} />
      <RelayTabDialogs controller={controller} status={relay.status} />
    </div>
  );
}

function RelayTabHeader({
  controller,
  status,
}: { controller: RelayController; status: RelayStatusResponse }) {
  const { t } = useTranslation();
  const { relay } = controller;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-medium">{t('relay.admin.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('relay.admin.description')}</p>
        </div>
        <div className="flex items-center gap-1">
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
          <RelayAdminMenu onChangePassword={controller.openPassword} />
        </div>
      </div>
      {!status.config.hasPassword && (
        <Notice tone="warning" testId="relay-password-unset-warning">
          {t('relay.admin.password.unsetWarning')}
        </Notice>
      )}
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
  api,
}: { controller: RelayController; status: RelayStatusResponse; api: RelayAdminApi }) {
  const { relay } = controller;
  // 指标与状态/写操作共用同一个注入的 api：多实例宿主与测试都不该退回默认 client。
  // 这里是采样回路的唯一持有者，指标面板与接入节点卡读同一份快照。
  const metrics = useRelayMetrics({ api });
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);

  // 相对时间以「这份数据是什么时候拉到的」为基准：每一拍推进一次，中间不必逐秒重渲染。
  const now = relay.loadedAt ?? Date.now();
  // 刷新后租户没了就当没选：不必再拿一个 effect 去同步。
  const selectedTenant = status.tenants.find((row) => row.id === selectedTenantId) ?? null;
  const clearSelection = () => setSelectedTenantId(null);

  return (
    <>
      <Reveal>
        <RelayMetricsPanel metrics={metrics} />
      </Reveal>

      <Reveal delayMs={60}>
        <TenantsCard
          controller={controller}
          status={status}
          now={now}
          selectedTenantId={selectedTenant?.id ?? null}
          onSelectTenant={(id) => setSelectedTenantId((prev) => (prev === id ? null : id))}
          onClearSelection={clearSelection}
        />
      </Reveal>

      {metrics.data !== null && (
        <Reveal delayMs={120}>
          <RelayMembersCard
            members={metrics.data.members}
            now={metrics.loadedAt ?? metrics.data.sampledAt}
            tenant={selectedTenant}
            onClearTenant={clearSelection}
          />
        </Reveal>
      )}
    </>
  );
}

function RelayTabDialogs({
  controller,
  status,
}: { controller: RelayController; status: RelayStatusResponse }) {
  const { t } = useTranslation();
  const { password, quota, tenant } = controller;
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

      <DefaultQuotaDialog
        open={controller.quotaOpen}
        quota={status.config.defaultQuota}
        busy={quota.busy}
        error={quota.error ? t('relay.admin.quota.failed', { message: quota.error }) : null}
        onOpenChange={(next) => {
          if (next) controller.openQuota();
          else controller.closeQuota();
        }}
        onSave={controller.submitDefaultQuota}
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
