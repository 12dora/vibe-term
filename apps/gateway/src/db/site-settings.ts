import { SITE_SETTING_FIELDS, type SiteSettingField, type SiteSettings } from '@vibeterm/shared';
import { eq } from 'drizzle-orm';
import { getSiteSettingsLinkProvider } from '../api/site-settings-link';
import { config } from '../config';
import { i18next } from '../i18n';
import { getDb as getOrmDb } from './client';
import { normalizeLocale, toSiteSettings } from './mappers';
import { siteSettings } from './schema';

const CONFIG_INITIALIZERS: Partial<Record<SiteSettingField['key'], () => unknown>> = {
  siteName: () => config.siteNameDefault,
  siteUrl: () => config.baseUrl,
  bellThrottleSeconds: () => config.bellThrottleSecondsDefault,
  notificationThrottleSeconds: () => config.notificationThrottleSecondsDefault,
  sshReconnectMaxRetries: () => config.sshReconnectMaxRetriesDefault,
  sshReconnectDelaySeconds: () => config.sshReconnectDelaySecondsDefault,
  language: () => normalizeLocale(config.languageDefault),
};

function initialSiteSettingValue(field: SiteSettingField, now: string): unknown {
  if (field.key === 'updatedAt') return now;
  const fromConfig = CONFIG_INITIALIZERS[field.key];
  return fromConfig ? fromConfig() : field.default;
}

function initialSiteSettingsValues(now: string): typeof siteSettings.$inferInsert {
  const values: Record<string, unknown> = { id: 1 };
  for (const field of SITE_SETTING_FIELDS) {
    values[field.key] = initialSiteSettingValue(field, now);
  }
  return values as typeof siteSettings.$inferInsert;
}

export function ensureSiteSettingsInitialized(): void {
  getOrmDb()
    .insert(siteSettings)
    .values(initialSiteSettingsValues(new Date().toISOString()))
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

export function getStoredSiteSettings(): SiteSettings {
  if (siteSettingsCache && Date.now() < siteSettingsCache.expiresAt) {
    return siteSettingsCache.value;
  }
  return refreshSiteSettingsCache();
}

export function getSiteSettings(): SiteSettings {
  const stored = getStoredSiteSettings();
  const link = getSiteSettingsLinkProvider();
  if (!link.linked()) return stored;
  const effective = link.effectiveSiteUrl();
  if (!effective || effective === stored.siteUrl) return stored;
  return { ...stored, siteUrl: effective };
}

function applySiteSettingUpdate(next: SiteSettings, field: SiteSettingField, value: unknown): void {
  if (field.key === 'language') {
    next.language = normalizeLocale(value as string);
    return;
  }
  (next as Record<string, unknown>)[field.key] = value;
}

function mergeSiteSettings(
  current: SiteSettings,
  updates: Partial<Omit<SiteSettings, 'updatedAt'>>
): SiteSettings {
  const next: SiteSettings = { ...current, updatedAt: new Date().toISOString() };
  for (const field of SITE_SETTING_FIELDS) {
    if (field.key === 'updatedAt') continue;
    const value = updates[field.key as keyof typeof updates];
    if (value === undefined) continue;
    applySiteSettingUpdate(next, field, value);
  }
  return next;
}

function siteSettingsRow(settings: SiteSettings): Omit<typeof siteSettings.$inferInsert, 'id'> {
  const row: Record<string, unknown> = {};
  for (const field of SITE_SETTING_FIELDS) {
    row[field.key] = settings[field.key];
  }
  return row as Omit<typeof siteSettings.$inferInsert, 'id'>;
}

export function updateSiteSettings(
  updates: Partial<Omit<SiteSettings, 'updatedAt'>>
): SiteSettings {
  const next = mergeSiteSettings(getStoredSiteSettings(), updates);

  getOrmDb().update(siteSettings).set(siteSettingsRow(next)).where(eq(siteSettings.id, 1)).run();

  siteSettingsCache = { value: next, expiresAt: Date.now() + SITE_SETTINGS_TTL_MS };

  if (i18next.language !== next.language) {
    void i18next.changeLanguage(next.language);
  }

  return next;
}
