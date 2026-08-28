import type { WatchRuleDto } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Bell, Loader2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WatchQueryStatus } from './use-watch-rules';
import { WatchRuleRow } from './watch-rule-row';

export interface WatchRuleListProps {
  rules: WatchRuleDto[];
  status: WatchQueryStatus;
  showNotifBanner: boolean;
  onDismissNotifBanner: () => void;
  onRetry: () => void;
  onToggle: (rule: WatchRuleDto, enabled: boolean) => void;
  onEdit: (rule: WatchRuleDto) => void;
  onViewState: (rule: WatchRuleDto) => void;
  onDelete: (rule: WatchRuleDto) => void;
  onAdd: () => void;
}

export function WatchRuleList(props: WatchRuleListProps) {
  const { t } = useTranslation();
  const { rules, status } = props;

  return (
    <div className="space-y-3">
      {props.showNotifBanner && <WatchNotifBanner onDismiss={props.onDismissNotifBanner} />}

      {status === 'loading' && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {status === 'error' && <WatchRulesError onRetry={props.onRetry} />}

      {status === 'ready' && rules.length === 0 && (
        <p
          className="py-6 text-center text-sm text-muted-foreground"
          data-testid="watch-rules-empty"
        >
          {t('watch.rules.empty')}
        </p>
      )}

      {rules.map((rule) => (
        <WatchRuleRow
          key={rule.id}
          rule={rule}
          onToggle={(enabled) => props.onToggle(rule, enabled)}
          onEdit={() => props.onEdit(rule)}
          onViewState={() => props.onViewState(rule)}
          onDelete={() => props.onDelete(rule)}
        />
      ))}

      <Button
        variant="outline"
        className="w-full"
        data-testid="watch-rule-add"
        onClick={props.onAdd}
      >
        <Plus className="h-4 w-4" />
        {t('watch.rules.addRule')}
      </Button>
    </div>
  );
}

function WatchRulesError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2 py-4 text-center" data-testid="watch-rules-error">
      <p className="text-sm text-destructive">{t('watch.rules.loadFailed')}</p>
      <Button variant="outline" size="sm" data-testid="watch-rules-retry" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

function WatchNotifBanner({ onDismiss }: { onDismiss: () => void }) {
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
          <Button
            size="sm"
            data-testid="watch-notif-enable"
            onClick={() => {
              void Notification.requestPermission().finally(onDismiss);
            }}
          >
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
