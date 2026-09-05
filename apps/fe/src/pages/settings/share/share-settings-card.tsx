// 分享设置：记录日志、保留天数、单条上限、默认分享地址。
// 草稿与校验在 share-settings-form.ts，这里只摆控件。

import type { ShareOriginCandidate, ShareSettings } from '@tmex/shared/share';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Switch } from '@tmex/ui/switch';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, Notice } from '../components/form-primitives';
import { SettingsSaveButton } from '../settings-save-button';
import {
  SHARE_ORIGIN_AUTO,
  SHARE_ORIGIN_CUSTOM,
  type ShareSettingsDraft,
  type ShareSettingsErrors,
  parseShareSettingsDraft,
  shareSettingsChanged,
  shareSettingsToDraft,
} from './share-settings-form';

export interface ShareSettingsCardProps {
  settings: ShareSettings;
  candidates: readonly ShareOriginCandidate[];
  saving: boolean;
  saveError: string | null;
  onSave: (next: ShareSettings) => void;
}

export function ShareSettingsCard({
  settings,
  candidates,
  saving,
  saveError,
  onSave,
}: ShareSettingsCardProps) {
  const { t } = useTranslation();
  const urls = candidates.map((candidate) => candidate.url);
  const [draft, setDraft] = useState<ShareSettingsDraft>(() =>
    shareSettingsToDraft(settings, urls)
  );
  const [errors, setErrors] = useState<ShareSettingsErrors>({});

  // 服务端值变了（保存成功回流、或别处改过）就以它为准重新起草，未保存的改动本就该让位。
  const [lastSettings, setLastSettings] = useState(settings);
  if (lastSettings !== settings) {
    setLastSettings(settings);
    setDraft(shareSettingsToDraft(settings, urls));
    setErrors({});
  }

  const patch = (next: Partial<ShareSettingsDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  const submit = () => {
    const parsed = parseShareSettingsDraft(draft);
    setErrors(parsed.errors);
    if (parsed.settings) onSave(parsed.settings);
  };

  return (
    <Card data-testid="share-settings-card">
      <CardHeader>
        <CardTitle>{t('settings.share.form.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex items-center justify-between gap-3" htmlFor="share-record-logs">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t('settings.share.form.recordLogs')}</span>
            <span className="block text-xs text-muted-foreground">
              {t('settings.share.form.recordLogsHint')}
            </span>
          </span>
          <Switch
            id="share-record-logs"
            checked={draft.recordLogs}
            disabled={saving}
            onCheckedChange={(next) => patch({ recordLogs: next === true })}
            data-testid="share-record-logs"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            id="share-retention-days"
            label={t('settings.share.form.retentionDays')}
            hint={t('settings.share.form.retentionHint')}
            error={errors.retentionDays ? t(errors.retentionDays) : undefined}
            spacing="tight"
          >
            <Input
              id="share-retention-days"
              inputMode="numeric"
              value={draft.retentionDays}
              disabled={saving || !draft.recordLogs}
              onChange={(event) => patch({ retentionDays: event.target.value })}
              data-testid="share-retention-days"
            />
          </FormField>

          <FormField
            id="share-log-max"
            label={t('settings.share.form.logMax')}
            hint={t('settings.share.form.logMaxHint')}
            error={errors.logMaxMb ? t(errors.logMaxMb) : undefined}
            spacing="tight"
          >
            <Input
              id="share-log-max"
              inputMode="numeric"
              value={draft.logMaxMb}
              disabled={saving || !draft.recordLogs}
              onChange={(event) => patch({ logMaxMb: event.target.value })}
              data-testid="share-log-max"
            />
          </FormField>
        </div>

        <OriginField
          draft={draft}
          errors={errors}
          candidates={candidates}
          disabled={saving}
          patch={patch}
        />

        {saveError && (
          <Notice tone="error" testId="share-settings-save-error">
            {t('settings.share.form.saveFailed', { message: saveError })}
          </Notice>
        )}

        <SettingsSaveButton
          onSave={submit}
          isSaving={saving}
          disabled={!shareSettingsChanged(draft, settings)}
        />
      </CardContent>
    </Card>
  );
}

function originLabel(
  t: (key: string) => string,
  candidates: readonly ShareOriginCandidate[],
  choice: string
): string {
  if (choice === SHARE_ORIGIN_AUTO) return t('settings.share.form.originAuto');
  if (choice === SHARE_ORIGIN_CUSTOM) return t('settings.share.form.originCustom');
  return candidates.find((candidate) => candidate.url === choice)?.label ?? choice;
}

function OriginField({
  draft,
  errors,
  candidates,
  disabled,
  patch,
}: {
  draft: ShareSettingsDraft;
  errors: ShareSettingsErrors;
  candidates: readonly ShareOriginCandidate[];
  disabled: boolean;
  patch: (next: Partial<ShareSettingsDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <FormField
      id="share-default-origin"
      label={t('settings.share.form.defaultOrigin')}
      hint={t('settings.share.form.defaultOriginHint')}
      error={errors.customOrigin ? t(errors.customOrigin) : undefined}
      spacing="tight"
    >
      <div className="flex flex-col gap-2">
        <Select
          value={draft.originChoice}
          onValueChange={(next) => next && patch({ originChoice: String(next) })}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-80"
            disabled={disabled}
            data-testid="share-default-origin"
          >
            <SelectValue>{originLabel(t, candidates, draft.originChoice)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SHARE_ORIGIN_AUTO}>{t('settings.share.form.originAuto')}</SelectItem>
            {candidates.map((candidate) => (
              <SelectItem key={candidate.url} value={candidate.url}>
                {candidate.label}
              </SelectItem>
            ))}
            <SelectItem value={SHARE_ORIGIN_CUSTOM}>
              {t('settings.share.form.originCustom')}
            </SelectItem>
          </SelectContent>
        </Select>
        {draft.originChoice === SHARE_ORIGIN_CUSTOM && (
          <Input
            id="share-custom-origin"
            className="w-full sm:w-80"
            placeholder="https://example.com"
            value={draft.customOrigin}
            disabled={disabled}
            onChange={(event) => patch({ customOrigin: event.target.value })}
            data-testid="share-custom-origin"
          />
        )}
      </div>
    </FormField>
  );
}
