import {
  type LocaleCode,
  PRODUCT_NAME,
  type SiteSettings,
  type UpdateSiteSettingsRequest,
} from '@tmex/shared';

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

const DEFAULT_SITE_NAME = PRODUCT_NAME;
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

/**
 * 决定是否要把浏览器级的 i18next 语言切到 `targetLanguage`，返回要切的语言或 `null`。
 *
 * i18next 是整页共享的单例：只有自身 runtime（`controlsBrowserPrefs`）的设置页才允许改它，
 * 远端 node（`/n/<id>/...`）的语言设置只属于那台 node，改了会掀翻整页 UI 语言。
 */
export function resolveLanguageSwitch(params: {
  controlsBrowserPrefs: boolean;
  currentLanguage: string;
  targetLanguage: LocaleCode | null | undefined;
}): LocaleCode | null {
  const { controlsBrowserPrefs, currentLanguage, targetLanguage } = params;
  if (!controlsBrowserPrefs || !targetLanguage || targetLanguage === currentLanguage) {
    return null;
  }
  return targetLanguage;
}

export interface LanguagePreviewController {
  /** 站点设置加载/重拉完成：该语言成为「已保存语言」（回退目标），界面语言同步过去 */
  hydrate: (savedLanguage: LocaleCode) => void;
  /** 用户在下拉里改了语言：立即预览（传 undefined 表示这次改的不是语言字段） */
  preview: (language: LocaleCode | null | undefined) => void;
  /** 保存成功：草稿语言成为已保存语言，之后离开设置页不再回退 */
  commit: (savedLanguage: LocaleCode) => void;
  /** 离开设置页：未保存的语言预览退回已保存的语言 */
  release: () => void;
}

/**
 * 语言实时预览控制器：下拉里选中即切整页 UI 语言，未保存就离开设置页则退回已保存的语言。
 *
 * 「已保存语言」不放 React state——回退发生在卸载清理里，那时读到的 state 是闭包里的旧值。
 */
export function createLanguagePreviewController(options: {
  controlsBrowserPrefs: () => boolean;
  currentLanguage: () => string;
  changeLanguage: (language: LocaleCode) => void;
}): LanguagePreviewController {
  // 设置加载完之前是 null：此时草稿还是默认值而非用户的选择，既不预览也不回退
  let savedLanguage: LocaleCode | null = null;

  function switchTo(targetLanguage: LocaleCode | null | undefined): void {
    const next = resolveLanguageSwitch({
      controlsBrowserPrefs: options.controlsBrowserPrefs(),
      currentLanguage: options.currentLanguage(),
      targetLanguage,
    });
    if (next) {
      options.changeLanguage(next);
    }
  }

  return {
    hydrate(language) {
      savedLanguage = language;
      // 重拉设置会覆盖草稿（含未保存的语言选择），界面语言得跟着回到已保存值，两者不能脱节
      switchTo(language);
    },
    preview(language) {
      switchTo(language);
    },
    commit(language) {
      savedLanguage = language;
    },
    release() {
      switchTo(savedLanguage);
    },
  };
}
