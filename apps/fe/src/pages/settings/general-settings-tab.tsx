import { VersionTab } from '@tmex/panels/settings';
import { I18N_MANIFEST, type LocaleCode } from '@tmex/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { useTranslation } from 'react-i18next';
import { SettingsSaveButton } from './settings-save-button';
import type { SiteSettingsForm } from './use-site-settings-form';

interface GeneralSettingsTabProps {
  form: SiteSettingsForm;
}

export function GeneralSettingsTab({ form }: GeneralSettingsTabProps) {
  const { t } = useTranslation();
  const { draft, updateDraft, showRefreshNotice } = form;

  return (
    <>
      <Card className="border-0 ring-0">
        <CardHeader>
          <CardTitle>{t('settings.siteSettings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="site-name-input">
              {t('settings.siteName')}
            </label>
            <Input
              id="site-name-input"
              value={draft.siteName}
              onChange={(event) => updateDraft({ siteName: event.target.value })}
              placeholder={t('settings.siteNamePlaceholder')}
              className="min-h-10"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="site-url-input">
              {t('settings.siteUrl')}
            </label>
            <Input
              id="site-url-input"
              value={draft.siteUrl}
              onChange={(event) => updateDraft({ siteUrl: event.target.value })}
              placeholder={t('settings.siteUrlPlaceholder')}
              className="min-h-10"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="language-select">
              {t('settings.language')}
            </label>
            <Select
              value={draft.language}
              onValueChange={(nextValue) => {
                if (!nextValue) return;
                updateDraft({ language: nextValue as LocaleCode });
              }}
            >
              <SelectTrigger
                id="language-select"
                data-testid="settings-language-select"
                className="w-full min-h-10"
              >
                <SelectValue placeholder={t('settings.language')}>
                  {I18N_MANIFEST.locales.find((l) => l.code === draft.language)?.nativeName ??
                    draft.language}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="max-h-[var(--tmex-viewport-height)]">
                {I18N_MANIFEST.locales.map((locale) => (
                  <SelectItem key={locale.code} value={locale.code}>
                    {locale.nativeName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showRefreshNotice && (
              <p className="mt-1 text-xs text-primary" data-testid="settings-refresh-notice">
                {t('settings.refreshToApply')}
              </p>
            )}
          </div>

          <SettingsSaveButton onSave={form.save} isSaving={form.isSaving} />
        </CardContent>
      </Card>

      <VersionTab />
    </>
  );
}
