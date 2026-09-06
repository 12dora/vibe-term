// 「通用」卡里的两个联动字段：站点名称与站点访问 URL。
// 与标签壳分开成文件，一是壳被 SettingsPage 的测试整模块替换（`mock.module`）后这两个字段就
// 没法单独渲染断言，二是这两个字段的联动逻辑本来就与卡片版式无关。

import { Input } from '@tmex/ui/input';
import { useTranslation } from 'react-i18next';
import { SiteUrlCandidates } from './site-url-candidates';
import type { SiteSettingsForm } from './use-site-settings-form';

export interface SettingsFieldProps {
  form: SiteSettingsForm;
}

export function FieldHint({ children, testId }: { children: string; testId: string }) {
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
export function SiteNameField({ form }: SettingsFieldProps) {
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

/**
 * 访问地址：由 Hub 托管时（本机是 hub 节点，或上联到 hub）只读展示，PATCH 里也不带这一项；
 * 经中继接入与 standalone 都可自行填写。两种情况都把本机实际可用的入口列在下方——可编辑时
 * 能一键填入，只读时只能复制。
 */
export function SiteUrlField({ form }: SettingsFieldProps) {
  const { t } = useTranslation();
  const { draft, updateDraft, linkage } = form;
  const effectiveUrl = linkage.effectiveSiteUrl ?? draft.siteUrl;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor="site-url-input">
        {t('settings.siteUrl')}
      </label>
      {linkage.siteUrlEditable ? (
        <>
          <Input
            id="site-url-input"
            value={draft.siteUrl}
            onChange={(event) => updateDraft({ siteUrl: event.target.value })}
            placeholder={t('settings.siteUrlPlaceholder')}
            className="min-h-10"
          />
          <FieldHint testId="settings-site-url-hint">{t('settings.general.urlHint')}</FieldHint>
          <SiteUrlCandidates
            candidates={linkage.siteAccessOrigins}
            currentValue={draft.siteUrl}
            onUse={(siteUrl) => updateDraft({ siteUrl })}
          />
        </>
      ) : (
        <>
          <Input
            id="site-url-input"
            value={effectiveUrl}
            readOnly
            className="min-h-10 bg-muted/50 text-muted-foreground"
            data-testid="settings-site-url-readonly"
          />
          <FieldHint testId="settings-site-url-hint">
            {t('settings.general.urlManagedHint')}
          </FieldHint>
          <SiteUrlCandidates candidates={linkage.siteAccessOrigins} currentValue={effectiveUrl} />
        </>
      )}
    </div>
  );
}
