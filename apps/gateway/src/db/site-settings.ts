import type { SiteSettings } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { i18next } from '../i18n';
import { getDb as getOrmDb } from './client';
import { normalizeLocale, toSiteSettings } from './mappers';
import { siteSettings } from './schema';

export function ensureSiteSettingsInitialized(): void {
  const orm = getOrmDb();
  const now = new Date().toISOString();

  orm
    .insert(siteSettings)
    .values({
      id: 1,
      siteName: config.siteNameDefault,
      siteUrl: config.baseUrl,
      bellThrottleSeconds: config.bellThrottleSecondsDefault,
      notificationThrottleSeconds: config.notificationThrottleSecondsDefault,
      enableBrowserNotificationToast: true,
      enableNotificationPush: true,
      enableBellPush: true,
      enableBellSound: true,
      sshReconnectMaxRetries: config.sshReconnectMaxRetriesDefault,
      sshReconnectDelaySeconds: config.sshReconnectDelaySecondsDefault,
      language: normalizeLocale(config.languageDefault),
      disabledNotificationChannels: [],
      updatedAt: now,
    })
    .onConflictDoNothing({ target: siteSettings.id })
    .run();
}

let siteSettingsCache: { value: SiteSettings; expiresAt: number } | null = null;
const SITE_SETTINGS_TTL_MS = 30_000;

function refreshSiteSettingsCache(): SiteSettings {
  const orm = getOrmDb();
  let row = orm.select().from(siteSettings).where(eq(siteSettings.id, 1)).get();

  if (!row) {
    ensureSiteSettingsInitialized();
    row = orm.select().from(siteSettings).where(eq(siteSettings.id, 1)).get();
  }

  if (!row) {
    throw new Error('site_settings not initialized');
  }

  const settings = toSiteSettings(row);
  siteSettingsCache = { value: settings, expiresAt: Date.now() + SITE_SETTINGS_TTL_MS };

  if (i18next.language !== settings.language) {
    void i18next.changeLanguage(settings.language);
  }

  return settings;
}

export function getSiteSettings(): SiteSettings {
  if (siteSettingsCache && Date.now() < siteSettingsCache.expiresAt) {
    return siteSettingsCache.value;
  }
  return refreshSiteSettingsCache();
}

function omitNullish<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (value != null) {
      out[key] = value;
    }
  }
  return out;
}

export function updateSiteSettings(
  updates: Partial<Omit<SiteSettings, 'updatedAt'>>
): SiteSettings {
  const current = getSiteSettings();
  const next: SiteSettings = {
    ...current,
    ...omitNullish(updates),
    language: updates.language ? normalizeLocale(updates.language) : current.language,
    updatedAt: new Date().toISOString(),
  };

  const orm = getOrmDb();
  orm.update(siteSettings).set(next).where(eq(siteSettings.id, 1)).run();

  siteSettingsCache = { value: next, expiresAt: Date.now() + SITE_SETTINGS_TTL_MS };

  if (i18next.language !== next.language) {
    void i18next.changeLanguage(next.language);
  }

  return next;
}
