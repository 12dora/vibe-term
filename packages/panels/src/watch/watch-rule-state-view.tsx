import type { LocaleCode, WatchRuleDto, WatchRuleSampleDto, WatchRuleStateDto } from '@tmex/shared';
import { formatDateTime } from '@tmex/shared';
import { useSiteStore } from '@tmex/stores/react';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type WatchQueryStatus, useWatchRuleState } from './use-watch-rules';
import type { TranslateFn } from './watch-rule-row';

export interface WatchStateField {
  label: string;
  value: string;
}

export function buildWatchStateFields(
  state: WatchRuleStateDto | null,
  t: TranslateFn,
  language: LocaleCode
): WatchStateField[] {
  const none = t('watch.state.none');
  return [
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
}

export interface WatchRuleStatePanelProps {
  rule: WatchRuleDto;
  status: WatchQueryStatus;
  state: WatchRuleStateDto | null;
  samples: WatchRuleSampleDto[];
  onBack: () => void;
  onRetry: () => void;
}

export function WatchRuleStatePanel({
  rule,
  status,
  state,
  samples,
  onBack,
  onRetry,
}: WatchRuleStatePanelProps) {
  const { t } = useTranslation();
  const language = useSiteStore((site) => site.settings?.language ?? 'en_US');

  return (
    <div className="space-y-3" data-testid="watch-rule-state-view">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t('watch.state.back')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
        <Badge variant="secondary">{t(`watch.type.${rule.triggerType}`)}</Badge>
      </div>

      {status === 'loading' && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {status === 'error' && <WatchStateError onRetry={onRetry} />}
      {status === 'ready' && (
        <>
          <WatchStateFields fields={buildWatchStateFields(state, t, language)} />
          <WatchStateSamples samples={samples} language={language} />
        </>
      )}
    </div>
  );
}

export interface WatchRuleStateViewProps {
  rule: WatchRuleDto;
  onBack: () => void;
}

export function WatchRuleStateView({ rule, onBack }: WatchRuleStateViewProps) {
  const model = useWatchRuleState(rule.id);

  return (
    <WatchRuleStatePanel
      rule={rule}
      status={model.status}
      state={model.state}
      samples={model.samples}
      onBack={onBack}
      onRetry={model.retry}
    />
  );
}

function WatchStateError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2 py-4 text-center" data-testid="watch-rule-state-error">
      <p className="text-sm text-destructive">{t('watch.state.loadFailed')}</p>
      <Button variant="outline" size="sm" data-testid="watch-rule-state-retry" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

function WatchStateFields({ fields }: { fields: WatchStateField[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0 break-all">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WatchStateSamples({
  samples,
  language,
}: {
  samples: WatchRuleSampleDto[];
  language: LocaleCode;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{t('watch.state.samples')}</p>
      {samples.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('watch.state.samplesEmpty')}</p>
      ) : (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
          {[...samples].reverse().map((sample) => (
            <li key={sample.at} className="flex items-center gap-2 rounded bg-muted/60 px-2 py-1">
              <span className="shrink-0 font-mono text-muted-foreground">
                {formatDateTime(sample.at, language) || sample.at}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">
                {sample.value ?? t('watch.state.none')}
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
  );
}
