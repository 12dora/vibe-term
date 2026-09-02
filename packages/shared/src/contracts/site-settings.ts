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

/** mesh 运行态投影：站点访问 URL / 显示名是否由节点身份托管。 */
export interface SiteSettingsLinkFields {
  /** 用户实际应使用的访问 URL；standalone 等于存储的 siteUrl。 */
  effectiveSiteUrl: string | null;
  /** mesh（hub 或 node）下为 false，站点 URL 由运行时决定。 */
  siteUrlEditable: boolean;
  /** mesh 下为 true：站点名与本机 mesh 节点名同步。 */
  siteNameLinkedToNode: boolean;
  /** mesh 下为本机 node id，standalone 为 null。 */
  nodeId: string | null;
}

export type SiteSettingsView = SiteSettings & SiteSettingsLinkFields;

export interface GetSiteSettingsResponse extends SiteSettingsLinkFields {
  settings: SiteSettingsView;
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

export interface UpdateSiteSettingsResponse extends SiteSettingsLinkFields {
  settings: SiteSettingsView;
}
