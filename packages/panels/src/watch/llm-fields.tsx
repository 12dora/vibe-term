import type { LlmProviderDto } from '@vibeterm/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { Switch } from '@vibeterm/ui/switch';
import { Textarea } from '@vibeterm/ui/textarea';
import { useTranslation } from 'react-i18next';
import { LlmModelSelect } from '../settings/llm-model-select';
import type { SetWatchRuleField } from './use-watch-rule-draft';
import {
  FOLLOW_DEFAULT_VALUE,
  type WatchRuleDraft,
  isRegexTrigger,
  needsModelFor,
} from './watch-rule-draft';

interface LlmFieldsProps {
  formId: string;
  draft: WatchRuleDraft;
  setField: SetWatchRuleField;
}

export function LlmFields({ formId, draft, setField }: LlmFieldsProps) {
  const { t } = useTranslation();

  if (draft.triggerType !== 'llm') {
    return null;
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`${formId}-condition`}>
        {t('watch.form.conditionPrompt')}
      </label>
      <Textarea
        id={`${formId}-condition`}
        data-testid="watch-form-condition-prompt"
        value={draft.conditionPrompt}
        onChange={(event) => setField('conditionPrompt', event.target.value)}
        placeholder={t('watch.form.conditionPromptPlaceholder')}
        rows={3}
      />
    </div>
  );
}

interface ModelFieldsProps {
  formId: string;
  draft: WatchRuleDraft;
  onSelectProvider: (providerId: string | null) => void;
  /** 模型选择器的回填；清空模型时保留已选提供商，见 `applyModelSelection`。 */
  onSelectModel: (next: { providerId: string | null; modelId: string | null }) => void;
  providers: LlmProviderDto[];
}

export function ModelFields({
  formId,
  draft,
  onSelectProvider,
  onSelectModel,
  providers,
}: ModelFieldsProps) {
  const { t } = useTranslation();
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const selectedProvider = providers.find((provider) => provider.id === draft.providerId);

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium">{t('watch.form.model')}</span>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={draft.providerId ?? FOLLOW_DEFAULT_VALUE}
          onValueChange={(value) => {
            if (!value) return;
            onSelectProvider(value === FOLLOW_DEFAULT_VALUE ? null : value);
          }}
        >
          <SelectTrigger className="w-full" data-testid="watch-form-provider">
            <SelectValue>
              {draft.providerId
                ? (selectedProvider?.name ?? t('watch.form.providerUnavailable'))
                : t('watch.form.followGlobalDefault')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_DEFAULT_VALUE}>
              {t('watch.form.followGlobalDefault')}
            </SelectItem>
            {draft.providerId &&
              !enabledProviders.some((provider) => provider.id === draft.providerId) && (
                <SelectItem value={draft.providerId}>
                  {selectedProvider
                    ? `${selectedProvider.name} (${t('watch.form.providerDisabled')})`
                    : t('watch.form.providerUnavailable')}
                </SelectItem>
              )}
            {enabledProviders.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <LlmModelSelect
          id={`${formId}-model`}
          testId="watch-form-model"
          className="h-8"
          providers={providers}
          providerId={draft.providerId}
          modelId={draft.modelId || null}
          allowNone
          noneLabel={t('watch.form.followGlobalDefault')}
          onChange={onSelectModel}
        />
      </div>
      {needsModelFor(draft) && (
        <p
          className="rounded-md bg-primary/10 px-2 py-1.5 text-xs text-primary"
          data-testid="watch-form-model-hint"
        >
          {t('watch.form.modelRequiredHint')}
        </p>
      )}
    </div>
  );
}

interface LlmAugmentFieldsProps {
  draft: WatchRuleDraft;
  setField: SetWatchRuleField;
}

export function LlmAugmentFields({ draft, setField }: LlmAugmentFieldsProps) {
  const { t } = useTranslation();

  if (!isRegexTrigger(draft.triggerType)) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="block text-sm font-medium">{t('watch.form.confirmWithLlm')}</span>
          <span className="block text-xs text-muted-foreground">
            {t('watch.form.confirmWithLlmDesc')}
          </span>
        </div>
        <Switch
          checked={draft.confirmWithLlm}
          onCheckedChange={(checked) => setField('confirmWithLlm', Boolean(checked))}
          data-testid="watch-form-confirm-llm"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="block text-sm font-medium">{t('watch.form.summarizeWithLlm')}</span>
          <span className="block text-xs text-muted-foreground">
            {t('watch.form.summarizeWithLlmDesc')}
          </span>
        </div>
        <Switch
          checked={draft.summarizeWithLlm}
          onCheckedChange={(checked) => setField('summarizeWithLlm', Boolean(checked))}
          data-testid="watch-form-summarize-llm"
        />
      </div>
    </div>
  );
}
