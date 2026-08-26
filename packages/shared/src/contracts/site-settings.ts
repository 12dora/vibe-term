// 站点设置契约

import type { LocaleCode } from '../i18n/resources';

export type ThemeMode = 'dark' | 'light';

export interface SiteSettings {
  siteName: string;
  siteUrl: string;
  bellThrottleSeconds: number;
  notificationThrottleSeconds: number;
  enableBrowserNotificationToast: boolean;
  enableNotificationPush: boolean;
  enableBellPush: boolean;
  enableBellSound: boolean;
  sshReconnectMaxRetries: number;
  sshReconnectDelaySeconds: number;
  language: LocaleCode;
  theme: ThemeMode;
  /** 被禁用的通知 channel id 列表（如 'webhook' / 'telegram' / 'weixin' 或运行时注册的自定义 id） */
  disabledNotificationChannels: string[];
  updatedAt: string;
}

export interface GetSiteSettingsResponse {
  settings: SiteSettings;
}

export interface UpdateSiteSettingsRequest {
  siteName?: string;
  siteUrl?: string;
  bellThrottleSeconds?: number;
  notificationThrottleSeconds?: number;
  enableBrowserNotificationToast?: boolean;
  enableNotificationPush?: boolean;
  enableBellPush?: boolean;
  enableBellSound?: boolean;
  sshReconnectMaxRetries?: number;
  sshReconnectDelaySeconds?: number;
  language?: LocaleCode;
  disabledNotificationChannels?: string[];
}

export interface UpdateSiteSettingsResponse {
  settings: SiteSettings;
}
