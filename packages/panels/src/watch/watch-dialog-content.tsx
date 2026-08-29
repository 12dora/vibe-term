// WatchDialog 的三个视图：规则列表（含通知授权提示）、规则表单、单规则运行状态。

import { useQuery } from '@tanstack/react-query';
import { fetchWatchRuleState, watchRuleStateQueryKey } from '@tmex/api-client';
import type { WatchRuleDto } from '@tmex/shared';
import { formatDateTime } from '@tmex/shared';
import { useRuntime, useSiteStore } from '@tmex/stores/react';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Activity, ArrowLeft, Bell, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WatchDialogModel } from './use-watch-dialog-model';
import { WatchRuleForm } from './watch-rule-form';

interface WatchDialogContentProps {
  deviceId: string;
  paneId: string;
  model: WatchDialogModel;
}

export function WatchDialogContent({ deviceId, paneId, model }: WatchDialogContentProps) {
  const { view } = model;

  if (view.mode === 'form') {
    return (
      <WatchRuleForm
        deviceId={deviceId}
        paneId={paneId}
        rule={view.rule}
        onSaved={model.handleSaved}
        onCancel={() => model.setView({ mode: 'list' })}
      />
    );
  }

  if (view.mode === 'state') {
    return <WatchRuleStateView rule={view.rule} onBack={() => model.setView({ mode: 'list' })} />;
  }

  return <WatchRuleList model={model} />;
}

function WatchRuleList({ model }: { model: WatchDialogModel }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      {model.showNotifBanner && (
        <NotifPermissionBanner
          onEnable={model.requestNotifPermission}
          onDismiss={model.dismissNotifBanner}
        />
      )}

      {model.isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!model.isLoading && model.rules.length === 0 && (
        <p
          className="py-6 text-center text-sm text-muted-foreground"
          data-testid="watch-rules-empty"
        >
          {t('watch.rules.empty')}
        </p>
      )}

      {model.rules.map((rule) => (
        <WatchRuleRow
          key={rule.id}
          rule={rule}
          onToggle={(enabled) => model.toggleRule(rule, enabled)}
          onEdit={() => model.setView({ mode: 'form', rule })}
          onViewState={() => model.setView({ mode: 'state', rule })}
          onDelete={() => model.setDeleteCandidate(rule)}
        />
      ))}

      <Button
        variant="outline"
        className="w-full"
        data-testid="watch-rule-add"
        onClick={() => model.setView({ mode: 'form', rule: null })}
      >
        <Plus className="h-4 w-4" />
        {t('watch.rules.addRule')}
      </Button>
    </div>
  );
}

interface NotifPermissionBannerProps {
  onEnable: () => void;
  onDismiss: () => void;
}

function NotifPermissionBanner({ onEnable, onDismiss }: NotifPermissionBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3"
      data-testid="watch-notif-banner"
    >
      <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('watch.notifPermission.title')}</p>
        <p className="text-xs text-muted-foreground">{t('watch.notifPermission.desc')}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" data-testid="watch-notif-enable" onClick={onEnable}>
            {t('watch.notifPermission.enable')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('watch.notifPermission.dismiss')}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface WatchRuleRowProps {
  rule: WatchRuleDto;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onViewState: () => void;
  onDelete: () => void;
}

function WatchRuleRow({ rule, onToggle, onEdit, onViewState, onDelete }: WatchRuleRowProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const stateQuery = useQuery({
    queryKey: watchRuleStateQueryKey(rule.id),
    queryFn: () => fetchWatchRuleState(rule.id, apiClient),
    throwOnError: false,
  });

  const lastTriggeredAt = formatDateTime(stateQuery.data?.state?.lastTriggeredAt, language);

  return (
    <div
      className="rounded-lg border border-border p-3"
      data-testid={`watch-rule-item-${rule.id}`}
      data-rule-name={rule.name}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
        <Badge variant="secondary">{t(`watch.type.${rule.triggerType}`)}</Badge>
        <Switch
          checked={rule.enabled}
          onCheckedChange={(checked) => onToggle(Boolean(checked))}
          data-testid={`watch-rule-toggle-${rule.id}`}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">
          {lastTriggeredAt
            ? t('watch.rules.lastTriggered', { time: lastTriggeredAt })
            : t('watch.rules.neverTriggered')}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onViewState}
            title={t('watch.rules.viewState')}
            aria-label={t('watch.rules.viewState')}
            data-testid={`watch-rule-state-${rule.id}`}
          >
            <Activity className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            title={t('watch.rules.edit')}
            aria-label={t('watch.rules.edit')}
            data-testid={`watch-rule-edit-${rule.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            title={t('watch.rules.delete')}
            aria-label={t('watch.rules.delete')}
            data-testid={`watch-rule-delete-${rule.id}`}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
    </div>
  );
}

interface WatchRuleStateViewProps {
  rule: WatchRuleDto;
  onBack: () => void;
}

function WatchRuleStateView({ rule, onBack }: WatchRuleStateViewProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const stateQuery = useQuery({
    queryKey: watchRuleStateQueryKey(rule.id),
    queryFn: () => fetchWatchRuleState(rule.id, apiClient),
    refetchInterval: 5000,
    throwOnError: false,
  });

  const state = stateQuery.data?.state ?? null;
  const samples = stateQuery.data?.samples ?? [];
  const none = t('watch.state.none');

  const fields: Array<{ label: string; value: string }> = [
    {
      label: t('watch.state.lastSampledAt'),
      value: formatDateTime(state?.lastSampledAt, language) || none,
    },
    { label: t('watch.state.lastValue'), value: state?.lastValue ?? none },
    {
      label: t('watch.state.lastValueChangedAt'),
      value: formatDateTime(state?.lastValueChangedAt, language) || none,
    },
    {
      label: t('watch.state.lastTriggeredAt'),
      value: formatDateTime(state?.lastTriggeredAt, language) || none,
    },
    {
      label: t('watch.state.consecutiveErrors'),
      value: state ? String(state.consecutiveErrors) : none,
    },
    { label: t('watch.state.lastError'), value: state?.lastError ?? none },
  ];

  return (
    <div className="space-y-3" data-testid="watch-rule-state-view">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t('watch.state.back')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
        <Badge variant="secondary">{t(`watch.type.${rule.triggerType}`)}</Badge>
      </div>

      {stateQuery.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 break-all">{field.value}</dd>
              </div>
            ))}
          </dl>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('watch.state.samples')}</p>
            {samples.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('watch.state.samplesEmpty')}</p>
            ) : (
              <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
                {[...samples].reverse().map((sample) => (
                  <li
                    key={sample.at}
                    className="flex items-center gap-2 rounded bg-muted/60 px-2 py-1"
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {formatDateTime(sample.at, language) || sample.at}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {sample.value ?? none}
                    </span>
                    {sample.hit && (
                      <Badge variant="default" className="h-4 px-1 text-[10px]">
                        {t('watch.state.hit')}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
