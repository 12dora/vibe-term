import { useQuery } from '@tanstack/react-query';
import { VersionTab } from '@vibeterm/panels/settings/version';
import { I18N_MANIFEST, type LocaleCode } from '@vibeterm/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { SiteNameField, SiteUrlField } from './general-fields';
import { ROLE_LABEL_KEY } from './nodes/membership/role-transition';
import { SettingsSaveButton } from './settings-save-button';
import { LOCAL_STATUS_QUERY_KEY, fetchSelfLocalStatus } from './status-queries';
import type { SiteSettingsForm } from './use-site-settings-form';

/**
 * 「关于」卡与站点设置草稿无关：草稿每敲一键都会重渲染本标签，memo 把它挡在外面。
 * 运行模式来自 `/api/local/status`（与「多节点互联」标签同一份缓存），面板包里查不到，
 * 所以在宿主这边查好文案再传进去。
 */
const About = memo(function About() {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: LOCAL_STATUS_QUERY_KEY,
    queryFn: fetchSelfLocalStatus,
    throwOnError: false,
  });
  const role = status.data?.role;
  // 查不到本机运行态就不传，关于卡的那句话会省掉运行模式子句。
  return <VersionTab runMode={role ? t(ROLE_LABEL_KEY[role]) : undefined} />;
});

interface GeneralSettingsTabProps {
  form: SiteSettingsForm;
}

export function GeneralSettingsTab({ form }: GeneralSettingsTabProps) {
  const { t } = useTranslation();
  const { draft, updateDraft } = form;

  return (
    <>
      <Card className="border-0 ring-0">
        <CardHeader>
          <CardTitle>{t('settings.siteSettings')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <SiteNameField form={form} />
          <SiteUrlField form={form} />

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
              <SelectContent className="max-h-[var(--vibeterm-viewport-height)]">
                {I18N_MANIFEST.locales.map((locale) => (
                  <SelectItem key={locale.code} value={locale.code}>
                    {locale.nativeName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <SettingsSaveButton
            onSave={form.save}
            isSaving={form.isSaving}
            disabled={!form.canSave}
          />
        </CardContent>
      </Card>

      <About />
      {/* 中继模式下改名要签一条密钥日志记录，凭据对话框挂在这里。 */}
      {form.renameDialog}
    </>
  );
}
