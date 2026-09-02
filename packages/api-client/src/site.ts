// 站点设置 REST 端点

import type {
  GetSiteSettingsResponse,
  SiteSettingsLinkFields,
  SiteSettingsView,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';

function mergeSiteSettingsView(payload: GetSiteSettingsResponse): SiteSettingsView {
  return {
    ...payload.settings,
    effectiveSiteUrl: payload.effectiveSiteUrl ?? payload.settings.effectiveSiteUrl ?? null,
    siteUrlEditable: payload.siteUrlEditable ?? payload.settings.siteUrlEditable ?? true,
    siteNameLinkedToNode:
      payload.siteNameLinkedToNode ?? payload.settings.siteNameLinkedToNode ?? false,
    nodeId: payload.nodeId ?? payload.settings.nodeId ?? null,
  };
}

export async function fetchSiteSettings(
  client: ApiClient = defaultApiClient
): Promise<SiteSettingsView> {
  const res = await client.fetch('/api/settings/site');
  if (!res.ok) {
    throw new Error('Failed to load site settings');
  }
  const payload = (await res.json()) as GetSiteSettingsResponse;
  return mergeSiteSettingsView(payload);
}

export type { SiteSettingsLinkFields, SiteSettingsView };
