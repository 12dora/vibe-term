import type { LocaleCode, SiteSettings, UpdateSiteSettingsRequest } from '@tmex/shared';

export interface SiteSettingsDraft {
  siteName: string;
  siteUrl: string;
  language: LocaleCode;
  bellThrottleSeconds: number;
  notificationThrottleSeconds: number;
  enableBrowserNotificationToast: boolean;
  enableNotificationPush: boolean;
  enableBellPush: boolean;
  enableBellSound: boolean;
  sshReconnectMaxRetries: number;
  sshReconnectDelaySeconds: number;
}

const DEFAULT_SITE_NAME = 'tmex';
const DEFAULT_LANGUAGE: LocaleCode = 'en_US';
const DEFAULT_BELL_THROTTLE_SECONDS = 6;
const DEFAULT_NOTIFICATION_THROTTLE_SECONDS = 3;
const DEFAULT_SSH_RECONNECT_MAX_RETRIES = 2;
const DEFAULT_SSH_RECONNECT_DELAY_SECONDS = 10;

export function createDefaultSiteSettingsDraft(siteUrl: string): SiteSettingsDraft {
  return {
    siteName: DEFAULT_SITE_NAME,
    siteUrl,
    language: DEFAULT_LANGUAGE,
    bellThrottleSeconds: DEFAULT_BELL_THROTTLE_SECONDS,
    notificationThrottleSeconds: DEFAULT_NOTIFICATION_THROTTLE_SECONDS,
    enableBrowserNotificationToast: true,
    enableNotificationPush: true,
    enableBellPush: true,
    enableBellSound: true,
    sshReconnectMaxRetries: DEFAULT_SSH_RECONNECT_MAX_RETRIES,
    sshReconnectDelaySeconds: DEFAULT_SSH_RECONNECT_DELAY_SECONDS,
  };
}

export function siteSettingsToDraft(settings: SiteSettings): SiteSettingsDraft {
  return {
    siteName: settings.siteName,
    siteUrl: settings.siteUrl,
    language: settings.language ?? DEFAULT_LANGUAGE,
    bellThrottleSeconds: settings.bellThrottleSeconds,
    notificationThrottleSeconds:
      settings.notificationThrottleSeconds ?? DEFAULT_NOTIFICATION_THROTTLE_SECONDS,
    enableBrowserNotificationToast: settings.enableBrowserNotificationToast ?? true,
    enableNotificationPush: settings.enableNotificationPush ?? true,
    enableBellPush: settings.enableBellPush ?? true,
    enableBellSound: settings.enableBellSound ?? true,
    sshReconnectMaxRetries: settings.sshReconnectMaxRetries ?? DEFAULT_SSH_RECONNECT_MAX_RETRIES,
    sshReconnectDelaySeconds:
      settings.sshReconnectDelaySeconds ?? DEFAULT_SSH_RECONNECT_DELAY_SECONDS,
  };
}

export function buildSiteSettingsPayload(draft: SiteSettingsDraft): UpdateSiteSettingsRequest {
  return {
    siteName: draft.siteName,
    siteUrl: draft.siteUrl,
    language: draft.language,
    bellThrottleSeconds: draft.bellThrottleSeconds,
    notificationThrottleSeconds: draft.notificationThrottleSeconds,
    enableBrowserNotificationToast: draft.enableBrowserNotificationToast,
    enableNotificationPush: draft.enableNotificationPush,
    enableBellPush: draft.enableBellPush,
    enableBellSound: draft.enableBellSound,
    sshReconnectMaxRetries: draft.sshReconnectMaxRetries,
    sshReconnectDelaySeconds: draft.sshReconnectDelaySeconds,
  };
}
