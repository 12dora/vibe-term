import { defaultRuntime } from './default-runtime';

export function getSiteNameFallback(): string {
  const settings = defaultRuntime.stores.site.getState().settings;
  return settings?.siteName || 'tmex';
}

export function getSiteUrlFallback(): string {
  const settings = defaultRuntime.stores.site.getState().settings;
  return settings?.siteUrl || window.location.origin;
}
