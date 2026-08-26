import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { useTranslation } from 'react-i18next';
import type { SetWatchRuleField } from './use-watch-rule-draft';
import {
  type WatchRuleDraft,
  normalizeCooldownSeconds,
  normalizeIntervalSeconds,
} from './watch-rule-draft';

interface ScheduleFieldsProps {
  formId: string;
  draft: WatchRuleDraft;
  setField: SetWatchRuleField;
  minInterval: number;
}

export function ScheduleFields({ formId, draft, setField, minInterval }: ScheduleFieldsProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor={`${formId}-interval`}>
          {t('watch.form.intervalSeconds')}
        </label>
        <Input
          id={`${formId}-interval`}
          data-testid="watch-form-interval"
          type="number"
          min={minInterval}
          step={1}
          value={draft.intervalSeconds}
          onChange={(event) =>
            setField('intervalSeconds', normalizeIntervalSeconds(event.target.value))
          }
        />
        <p className="text-xs text-muted-foreground">
          {t('watch.form.intervalHint', { min: minInterval })}
        </p>
      </div>
      <div className="space-y-2">
        <span className="block text-sm font-medium">{t('watch.form.fireMode')}</span>
        <Select
          value={draft.fireMode}
          onValueChange={(value) => {
            if (value === 'once' || value === 'repeat') {
              setField('fireMode', value);
            }
          }}
        >
          <SelectTrigger className="w-full" data-testid="watch-form-fire-mode">
            <SelectValue>
              {draft.fireMode === 'once' ? t('watch.form.fireOnce') : t('watch.form.fireRepeat')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="once">{t('watch.form.fireOnce')}</SelectItem>
            <SelectItem value="repeat">{t('watch.form.fireRepeat')}</SelectItem>
          </SelectContent>
        </Select>
        {draft.fireMode === 'repeat' && (
          <Input
            data-testid="watch-form-cooldown"
            type="number"
            min={0}
            step={1}
            value={draft.cooldownSeconds}
            onChange={(event) =>
              setField('cooldownSeconds', normalizeCooldownSeconds(event.target.value))
            }
            aria-label={t('watch.form.cooldownSeconds')}
            placeholder={t('watch.form.cooldownSeconds')}
          />
        )}
      </div>
    </div>
  );
}
