import type { SiteSettings, SiteSettingsLinkFields, SiteSettingsView } from '@tmex/shared';

export type SiteSettingsLinkProvider = {
  effectiveSiteUrl(): string | null;
  localNodeId(): string | null;
  linked(): boolean;
};

export const STANDALONE_SITE_SETTINGS_LINK: SiteSettingsLinkProvider = {
  effectiveSiteUrl: () => null,
  localNodeId: () => null,
  linked: () => false,
};

let currentLink: SiteSettingsLinkProvider = STANDALONE_SITE_SETTINGS_LINK;

export function setSiteSettingsLinkProvider(provider: SiteSettingsLinkProvider | null): void {
  currentLink = provider ?? STANDALONE_SITE_SETTINGS_LINK;
}

export function getSiteSettingsLinkProvider(): SiteSettingsLinkProvider {
  return currentLink;
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
    siteUrlEditable: !linked,
    siteNameLinkedToNode: linked,
    nodeId: linked ? link.localNodeId() : null,
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
  };
}
