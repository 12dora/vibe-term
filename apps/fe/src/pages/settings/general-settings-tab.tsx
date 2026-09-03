import { VersionTab } from '@tmex/panels/settings/version';
import { I18N_MANIFEST, type LocaleCode } from '@tmex/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSaveButton } from './settings-save-button';
import type { SiteSettingsForm } from './use-site-settings-form';

// 版本卡与站点设置草稿无关：草稿每敲一键都会重渲染本标签，memo 把它挡在外面。
const Version = memo(VersionTab);

interface GeneralSettingsTabProps {
  form: SiteSettingsForm;
}

function FieldHint({ children, testId }: { children: string; testId: string }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * 站点名称：mesh 下它就是本节点在多节点互联里的名字，保存时走 hub 的 rename 接口。
 * 没有可写 hub 时改不了名，字段直接禁用——让人改完再吃一条 `HUB_NOT_WRITER` 毫无意义。
 */
function SiteNameField({ form }: GeneralSettingsTabProps) {
  const { t } = useTranslation();
  const { draft, updateDraft, linkage, canRenameNode } = form;
  const locked = linkage.siteNameLinkedToNode && !canRenameNode;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor="site-name-input">
        {t('settings.siteName')}
      </label>
      <Input
        id="site-name-input"
        value={draft.siteName}
        disabled={locked}
        onChange={(event) => updateDraft({ siteName: event.target.value })}
        placeholder={t('settings.siteNamePlaceholder')}
        className="min-h-10"
      />
      {linkage.siteNameLinkedToNode && (
        <FieldHint testId="settings-site-name-hint">
          {t(locked ? 'settings.general.nameLinkedLocked' : 'settings.general.nameLinkedHint')}
        </FieldHint>
      )}
    </div>
  );
}

/** 访问地址：mesh 下由 Hub 公开地址决定，本页只读展示，PATCH 里也不带这一项。 */
function SiteUrlField({ form }: GeneralSettingsTabProps) {
  const { t } = useTranslation();
  const { draft, updateDraft, linkage } = form;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor="site-url-input">
        {t('settings.siteUrl')}
      </label>
      {linkage.siteUrlEditable ? (
        <Input
          id="site-url-input"
          value={draft.siteUrl}
          onChange={(event) => updateDraft({ siteUrl: event.target.value })}
          placeholder={t('settings.siteUrlPlaceholder')}
          className="min-h-10"
        />
      ) : (
        <>
          <Input
            id="site-url-input"
            value={linkage.effectiveSiteUrl ?? draft.siteUrl}
            readOnly
            className="min-h-10 bg-muted/50 text-muted-foreground"
            data-testid="settings-site-url-readonly"
          />
          <FieldHint testId="settings-site-url-hint">
            {t('settings.general.urlManagedHint')}
          </FieldHint>
        </>
      )}
    </div>
  );
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
              <SelectContent className="max-h-[var(--tmex-viewport-height)]">
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

      <Version />
    </>
  );
}
