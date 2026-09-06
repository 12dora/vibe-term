import type { SiteSettings, SiteSettingsLinkFields, SiteSettingsView } from '@vibeterm/shared';
import type { ShareOriginCandidate } from '@vibeterm/shared/share';

export type SiteSettingsLinkProvider = {
  effectiveSiteUrl(): string | null;
  localNodeId(): string | null;
  /** 站点名与本机 mesh 节点名同步（hub / node 角色）。 */
  linked(): boolean;
  /** 站点 URL 由运行时托管、不可编辑：hub 角色，或经 hub 上联的节点。 */
  siteUrlManaged(): boolean;
};

/** `siteUrlManaged` 省略时退回 `linked`，保持旧调用方语义。 */
export type SiteSettingsLinkInput = Omit<SiteSettingsLinkProvider, 'siteUrlManaged'> & {
  siteUrlManaged?: () => boolean;
};

export const STANDALONE_SITE_SETTINGS_LINK: SiteSettingsLinkProvider = {
  effectiveSiteUrl: () => null,
  localNodeId: () => null,
  linked: () => false,
  siteUrlManaged: () => false,
};

let currentLink: SiteSettingsLinkProvider = STANDALONE_SITE_SETTINGS_LINK;
let accessOrigins: () => ShareOriginCandidate[] = () => [];

export function setSiteSettingsLinkProvider(provider: SiteSettingsLinkInput | null): void {
  currentLink = provider
    ? { ...provider, siteUrlManaged: provider.siteUrlManaged ?? provider.linked }
    : STANDALONE_SITE_SETTINGS_LINK;
}

export function getSiteSettingsLinkProvider(): SiteSettingsLinkProvider {
  return currentLink;
}

/** 由装配层注入分享地址候选（去掉自定义项），设置页用它展示「本机可被访问的地址」。 */
export function setSiteAccessOriginsProvider(
  provider: (() => ShareOriginCandidate[]) | null
): void {
  accessOrigins = provider ?? (() => []);
}

export function getSiteAccessOrigins(): ShareOriginCandidate[] {
  try {
    return accessOrigins();
  } catch {
    return [];
  }
}

export function sameManagedSiteUrl(left: string, right: string): boolean {
  return left.trim().replace(/\/+$/, '') === right.trim().replace(/\/+$/, '');
}

export function projectSiteSettings(
  stored: SiteSettings,
  link: SiteSettingsLinkProvider = getSiteSettingsLinkProvider()
): SiteSettingsView {
  const linked = link.linked();
  const managed = link.siteUrlManaged();
  const effective = (linked ? link.effectiveSiteUrl() : null) ?? stored.siteUrl;
  const fields: SiteSettingsLinkFields = {
    effectiveSiteUrl: effective,
    siteUrlEditable: !managed,
    siteNameLinkedToNode: linked,
    nodeId: linked ? link.localNodeId() : null,
    siteAccessOrigins: getSiteAccessOrigins(),
  };
  return {
    ...stored,
    siteUrl: effective,
    ...fields,
  };
}

export function toSiteSettingsHttpPayload(stored: SiteSettings): {
  settings: SiteSettingsView;
} & SiteSettingsLinkFields {
  const settings = projectSiteSettings(stored);
  return {
    settings,
    effectiveSiteUrl: settings.effectiveSiteUrl,
    siteUrlEditable: settings.siteUrlEditable,
    siteNameLinkedToNode: settings.siteNameLinkedToNode,
    nodeId: settings.nodeId,
    siteAccessOrigins: settings.siteAccessOrigins,
  };
}
