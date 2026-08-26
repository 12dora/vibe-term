import type { AssistRegexResponse } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SetWatchRuleField } from './use-watch-rule-draft';
import {
  type WatchRuleDraft,
  isRegexTrigger,
  normalizeExtractGroup,
  normalizeUnchangedMinutes,
} from './watch-rule-draft';

interface RegexTriggerFieldsProps {
  formId: string;
  draft: WatchRuleDraft;
  setField: SetWatchRuleField;
  assistDescription: string;
  onAssistDescriptionChange: (value: string) => void;
  onGenerateAssist: () => void;
  assistPending: boolean;
  assistResult: AssistRegexResponse | null;
}

export function RegexTriggerFields({
  formId,
  draft,
  setField,
  assistDescription,
  onAssistDescriptionChange,
  onGenerateAssist,
  assistPending,
  assistResult,
}: RegexTriggerFieldsProps) {
  const { t } = useTranslation();

  if (!isRegexTrigger(draft.triggerType)) {
    return null;
  }

  return (
    <>
      <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
        <label className="block text-sm font-medium" htmlFor={`${formId}-assist`}>
          {t('watch.form.assistLabel')}
        </label>
        <div className="flex gap-2">
          <Input
            id={`${formId}-assist`}
            data-testid="watch-form-assist-input"
            value={assistDescription}
            onChange={(event) => onAssistDescriptionChange(event.target.value)}
            placeholder={t('watch.form.assistPlaceholder')}
          />
          <Button
            type="button"
            variant="secondary"
            data-testid="watch-form-assist-generate"
            disabled={!assistDescription.trim() || assistPending}
            onClick={onGenerateAssist}
          >
            {assistPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {t('watch.form.assistButton')}
          </Button>
        </div>
        {assistResult && (
          <div className="space-y-1 text-xs" data-testid="watch-form-assist-result">
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {t('watch.form.assistExplanation')}:
              </span>{' '}
              {assistResult.explanation}
            </p>
            <p className="font-medium text-foreground">{t('watch.form.assistPreview')}:</p>
            {assistResult.preview.length === 0 ? (
              <p className="text-muted-foreground">{t('watch.form.assistPreviewEmpty')}</p>
            ) : (
              <ul className="max-h-24 space-y-0.5 overflow-y-auto">
                {assistResult.preview.map((hit, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: 预览命中是只读静态列表
                    key={index}
                    className="truncate rounded bg-muted px-1.5 py-0.5 font-mono"
                  >
                    {hit}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`${formId}-pattern`}>
            {t('watch.form.pattern')}
          </label>
          <Input
            id={`${formId}-pattern`}
            data-testid="watch-form-pattern"
            value={draft.pattern}
            onChange={(event) => setField('pattern', event.target.value)}
            placeholder={t('watch.form.patternPlaceholder')}
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`${formId}-flags`}>
            {t('watch.form.flags')}
          </label>
          <Input
            id={`${formId}-flags`}
            data-testid="watch-form-flags"
            value={draft.patternFlags}
            onChange={(event) => setField('patternFlags', event.target.value)}
            placeholder={t('watch.form.flagsPlaceholder')}
            className="font-mono"
          />
        </div>
      </div>

      {draft.triggerType === 'unchanged' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={`${formId}-extract-group`}>
              {t('watch.form.extractGroup')}
            </label>
            <Input
              id={`${formId}-extract-group`}
              data-testid="watch-form-extract-group"
              type="number"
              min={0}
              step={1}
              value={draft.extractGroup}
              onChange={(event) =>
                setField('extractGroup', normalizeExtractGroup(event.target.value))
              }
            />
            <p className="text-xs text-muted-foreground">{t('watch.form.extractGroupHint')}</p>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={`${formId}-unchanged-minutes`}>
              {t('watch.form.unchangedMinutes')}
            </label>
            <Input
              id={`${formId}-unchanged-minutes`}
              data-testid="watch-form-unchanged-minutes"
              type="number"
              min={1}
              step={1}
              value={draft.unchangedMinutes}
              onChange={(event) =>
                setField('unchangedMinutes', normalizeUnchangedMinutes(event.target.value))
              }
            />
          </div>
          <div className="col-span-2 space-y-2">
            <span className="block text-sm font-medium">{t('watch.form.noMatchBehavior')}</span>
            <Select
              value={draft.noMatchBehavior}
              onValueChange={(value) => {
                if (value === 'reset' || value === 'ignore') {
                  setField('noMatchBehavior', value);
                }
              }}
            >
              <SelectTrigger className="w-full" data-testid="watch-form-no-match-behavior">
                <SelectValue>
                  {draft.noMatchBehavior === 'reset'
                    ? t('watch.form.noMatchReset')
                    : t('watch.form.noMatchIgnore')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reset">{t('watch.form.noMatchReset')}</SelectItem>
                <SelectItem value="ignore">{t('watch.form.noMatchIgnore')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </>
  );
}
