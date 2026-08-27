import type { WatchRuleDto } from '@tmex/shared';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Activity, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 只取 i18n 的字符串取值面，避免行组件把整个 TFunction 泄进纯函数 */
export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 行内摘要只用规则自身字段，不依赖运行状态（状态需按规则单独请求） */
export function formatRuleSchedule(rule: WatchRuleDto, t: TranslateFn): string {
  const interval = t('watch.rules.everySeconds', { seconds: rule.intervalSeconds });
  if (rule.triggerType !== 'unchanged' || rule.unchangedMinutes === null) {
    return interval;
  }
  return `${t('watch.rules.unchangedFor', { minutes: rule.unchangedMinutes })} · ${interval}`;
}

export interface WatchRuleRowProps {
  rule: WatchRuleDto;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onViewState: () => void;
  onDelete: () => void;
}

export function WatchRuleRow({ rule, onToggle, onEdit, onViewState, onDelete }: WatchRuleRowProps) {
  const { t } = useTranslation();

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
          {formatRuleSchedule(rule, t)}
        </span>
        <WatchRuleRowActions
          ruleId={rule.id}
          onEdit={onEdit}
          onViewState={onViewState}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

interface WatchRuleRowActionsProps {
  ruleId: string;
  onEdit: () => void;
  onViewState: () => void;
  onDelete: () => void;
}

function WatchRuleRowActions({ ruleId, onEdit, onViewState, onDelete }: WatchRuleRowActionsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onViewState}
        title={t('watch.rules.viewState')}
        aria-label={t('watch.rules.viewState')}
        data-testid={`watch-rule-state-${ruleId}`}
      >
        <Activity className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onEdit}
        title={t('watch.rules.edit')}
        aria-label={t('watch.rules.edit')}
        data-testid={`watch-rule-edit-${ruleId}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDelete}
        title={t('watch.rules.delete')}
        aria-label={t('watch.rules.delete')}
        data-testid={`watch-rule-delete-${ruleId}`}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
    </div>
  );
}
