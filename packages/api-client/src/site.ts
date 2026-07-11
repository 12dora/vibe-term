// 站点设置 REST 端点

import type { SiteSettings } from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';

export async function fetchSiteSettings(
  client: ApiClient = defaultApiClient
): Promise<SiteSettings> {
  const res = await client.fetch('/api/settings/site');
  if (!res.ok) {
    throw new Error('Failed to load site settings');
  }
  const payload = (await res.json()) as { settings: SiteSettings };
  return payload.settings;
}
