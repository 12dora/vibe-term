import type { SiteSettings, SiteSettingsLinkFields, SiteSettingsView } from '@vibeterm/shared';
import type { ShareOriginCandidate } from '@vibeterm/shared/share';

export type SiteSettingsLinkProvider = {
  effectiveSiteUrl(): string | null;
  localNodeId(): string | null;
  /** 站点名与本机 mesh 节点名同步（node 角色）。 */
  linked(): boolean;
};

export const STANDALONE_SITE_SETTINGS_LINK: SiteSettingsLinkProvider = {
  effectiveSiteUrl: () => null,
  localNodeId: () => null,
  linked: () => false,
};

let currentLink: SiteSettingsLinkProvider = STANDALONE_SITE_SETTINGS_LINK;
let accessOrigins: () => ShareOriginCandidate[] = () => [];

export function setSiteSettingsLinkProvider(provider: SiteSettingsLinkProvider | null): void {
  currentLink = provider ?? STANDALONE_SITE_SETTINGS_LINK;
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
  const effective = (linked ? link.effectiveSiteUrl() : null) ?? stored.siteUrl;
  const fields: SiteSettingsLinkFields = {
    effectiveSiteUrl: effective,
    siteUrlEditable: true,
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
