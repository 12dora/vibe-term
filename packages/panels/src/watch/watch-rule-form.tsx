import { useMutation, useQuery } from '@tanstack/react-query';
import { assistRegex, createWatchRule, fetchLlmProviders, updateWatchRule } from '@tmex/api-client';
import { errorMessage } from '@tmex/shared';
import type { AssistRegexResponse, WatchRuleDto } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { toast } from '@tmex/ui/toast';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LlmAugmentFields, LlmFields, ModelFields } from './llm-fields';
import { RegexTriggerFields } from './regex-trigger-fields';
import { ScheduleFields } from './schedule-fields';
import { useWatchRuleDraft } from './use-watch-rule-draft';
import {
  TRIGGER_TYPES,
  buildAssistRegexRequest,
  buildCreateWatchRuleRequest,
  buildUpdateWatchRuleRequest,
} from './watch-rule-draft';

interface WatchRuleFormProps {
  deviceId: string;
  paneId: string;
  rule: WatchRuleDto | null;
  onSaved: (created: boolean) => void;
  onCancel: () => void;
}

export function WatchRuleForm({ deviceId, paneId, rule, onSaved, onCancel }: WatchRuleFormProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const formId = useId();

  const {
    draft,
    setField,
    selectTriggerType,
    selectProvider,
    acceptAssistResult,
    minInterval,
    validate,
  } = useWatchRuleDraft(rule);

  const [assistDescription, setAssistDescription] = useState('');
  const [assistResult, setAssistResult] = useState<AssistRegexResponse | null>(null);

  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => fetchLlmProviders(undefined, apiClient),
    throwOnError: false,
  });

  const providers = providersQuery.data?.providers ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (rule) {
        await updateWatchRule(rule.id, buildUpdateWatchRuleRequest(draft), apiClient);
        return false;
      }
      await createWatchRule(buildCreateWatchRuleRequest(draft, deviceId, paneId), apiClient);
      return true;
    },
    onSuccess: (created) => {
      toast.success(created ? t('watch.toast.created') : t('watch.toast.updated'));
      onSaved(created);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const assistMutation = useMutation({
    mutationFn: async () =>
      assistRegex(buildAssistRegexRequest(draft, assistDescription, deviceId, paneId), apiClient),
    onSuccess: (result) => {
      acceptAssistResult(result);
      setAssistResult(result);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  const handleSubmit = (): void => {
    const error = validate();
    if (error) {
      toast.error(t(error.key, error.params));
      return;
    }
    saveMutation.mutate();
  };

  return (
    <form
      data-testid="watch-rule-form"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor={`${formId}-name`}>
          {t('watch.form.name')}
        </label>
        <Input
          id={`${formId}-name`}
          data-testid="watch-form-name"
          value={draft.name}
          maxLength={120}
          onChange={(event) => setField('name', event.target.value)}
          placeholder={t('watch.form.namePlaceholder')}
        />
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium">{t('watch.form.triggerType')}</span>
        <div className="grid gap-2">
          {TRIGGER_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              data-testid={`watch-form-type-${type}`}
              onClick={() => selectTriggerType(type)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left transition-colors',
                draft.triggerType === type
                  ? 'border-primary/50 bg-primary/10'
                  : 'border-border hover:bg-accent/40'
              )}
            >
              <span className="block text-sm font-medium">{t(`watch.type.${type}`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`watch.typeDesc.${type}`)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <RegexTriggerFields
        formId={formId}
        draft={draft}
        setField={setField}
        assistDescription={assistDescription}
        onAssistDescriptionChange={setAssistDescription}
        onGenerateAssist={() => assistMutation.mutate()}
        assistPending={assistMutation.isPending}
        assistResult={assistResult}
      />

      <LlmFields formId={formId} draft={draft} setField={setField} />

      <ModelFields
        formId={formId}
        draft={draft}
        setField={setField}
        onSelectProvider={selectProvider}
        providers={providers}
      />

      <LlmAugmentFields draft={draft} setField={setField} />

      <ScheduleFields formId={formId} draft={draft} setField={setField} minInterval={minInterval} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} data-testid="watch-form-cancel">
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={saveMutation.isPending} data-testid="watch-form-save">
          {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {rule ? t('watch.form.save') : t('watch.form.create')}
        </Button>
      </div>
    </form>
  );
}
