import type { LocaleCode, SiteSettings, UpdateSiteSettingsRequest } from '@tmex/shared';
import { SUPPORTED_LOCALES } from '@tmex/shared';
import { t } from '../i18n';

export type SiteSettingsUpdates = Partial<Omit<SiteSettings, 'updatedAt'>>;

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(t('apiError.invalidRequest'));
  }
  return value;
}

export function normalizeSiteIdentity(
  body: UpdateSiteSettingsRequest,
  updates: SiteSettingsUpdates
): void {
  if (body.siteName !== undefined) {
    const value = body.siteName.trim();
    if (!value) throw new Error(t('apiError.siteNameRequired'));
    updates.siteName = value;
  }

  if (body.siteUrl !== undefined) {
    const value = body.siteUrl.trim();
    if (!/^https?:\/\//i.test(value)) {
      throw new Error(t('apiError.siteUrlInvalid'));
    }
    updates.siteUrl = value;
  }
}

export function normalizeThrottleSettings(
  body: UpdateSiteSettingsRequest,
  updates: SiteSettingsUpdates
): void {
  if (body.bellThrottleSeconds !== undefined) {
    const value = Math.floor(Number(body.bellThrottleSeconds));
    if (Number.isNaN(value) || value < 0 || value > 300) {
      throw new Error(t('apiError.bellThrottleInvalid'));
    }
    updates.bellThrottleSeconds = value;
  }

  if (body.notificationThrottleSeconds !== undefined) {
    const value = Math.floor(Number(body.notificationThrottleSeconds));
    if (Number.isNaN(value) || value < 0 || value > 300) {
      throw new Error(t('apiError.bellThrottleInvalid'));
    }
    updates.notificationThrottleSeconds = value;
  }
}

export function normalizeNotificationToggles(
  body: UpdateSiteSettingsRequest,
  updates: SiteSettingsUpdates
): void {
  if (body.enableBrowserNotificationToast !== undefined) {
    updates.enableBrowserNotificationToast = requireBoolean(body.enableBrowserNotificationToast);
  }

  if (body.enableNotificationPush !== undefined) {
    updates.enableNotificationPush = requireBoolean(body.enableNotificationPush);
  }

  if (body.enableBellPush !== undefined) {
    updates.enableBellPush = requireBoolean(body.enableBellPush);
  }

  if (body.enableBellSound !== undefined) {
    updates.enableBellSound = requireBoolean(body.enableBellSound);
  }
}

export function normalizeSshReconnectSettings(
  body: UpdateSiteSettingsRequest,
  updates: SiteSettingsUpdates
): void {
  if (body.sshReconnectMaxRetries !== undefined) {
    const value = Math.floor(Number(body.sshReconnectMaxRetries));
    if (Number.isNaN(value) || value < 0 || value > 20) {
      throw new Error(t('apiError.sshRetriesInvalid'));
    }
    updates.sshReconnectMaxRetries = value;
  }

  if (body.sshReconnectDelaySeconds !== undefined) {
    const value = Math.floor(Number(body.sshReconnectDelaySeconds));
    if (Number.isNaN(value) || value < 1 || value > 300) {
      throw new Error(t('apiError.sshDelayInvalid'));
    }
    updates.sshReconnectDelaySeconds = value;
  }
}

export function normalizeLanguageSetting(
  body: UpdateSiteSettingsRequest,
  updates: SiteSettingsUpdates
): void {
  if (body.language !== undefined) {
    const value = body.language.trim();
    if (!(SUPPORTED_LOCALES as readonly string[]).includes(value)) {
      throw new Error(t('apiError.languageInvalid'));
    }
    updates.language = value as LocaleCode;
  }
}

export function normalizeDisabledNotificationChannels(
  body: UpdateSiteSettingsRequest,
  updates: SiteSettingsUpdates
): void {
  // 宽松校验：只要求 string[]（trim 后非空、去重），不绑定「已注册 channel id」集合——
  // 自定义 channel 在运行时注册，设置写入时可能尚未注册，绑定会造成先后次序耦合。
  if (body.disabledNotificationChannels === undefined) return;

  if (
    !Array.isArray(body.disabledNotificationChannels) ||
    !body.disabledNotificationChannels.every((item) => typeof item === 'string')
  ) {
    throw new Error(t('apiError.invalidRequest'));
  }
  updates.disabledNotificationChannels = [
    ...new Set(body.disabledNotificationChannels.map((item) => item.trim()).filter(Boolean)),
  ];
}

export function normalizeSiteSettingsInput(body: UpdateSiteSettingsRequest): SiteSettingsUpdates {
  const updates: SiteSettingsUpdates = {};
  normalizeSiteIdentity(body, updates);
  normalizeThrottleSettings(body, updates);
  normalizeNotificationToggles(body, updates);
  normalizeSshReconnectSettings(body, updates);
  normalizeLanguageSetting(body, updates);
  normalizeDisabledNotificationChannels(body, updates);
  return updates;
}
