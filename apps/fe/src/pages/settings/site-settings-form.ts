import {
  type LocaleCode,
  PRODUCT_NAME,
  type SiteSettings,
  type SiteSettingsLinkFields,
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

/**
 * `GET /api/settings/site` 会随设置一并下发 `SiteSettingsLinkFields`，但站点设置 store 的
 * 返回类型仍是 `SiteSettings`（运行时带着这几个字段）：这里按可选收，老服务端不下发时
 * 一律落回「可自由编辑、不联动」的旧行为。
 */
export type SiteSettingsWithLinkage = SiteSettings & Partial<SiteSettingsLinkFields>;

export interface SiteSettingsLinkage {
  /** 站点名称即节点名称：改名要经 hub 的 rename 接口，不能走 PATCH。 */
  siteNameLinkedToNode: boolean;
  /** 访问地址可否在本页编辑；mesh 下由 Hub 公开地址决定，只读。 */
  siteUrlEditable: boolean;
  /** 实际生效的访问地址；未知为 `null`。 */
  effectiveSiteUrl: string | null;
  /** 联动的节点 id，即 rename 的目标；未知为 `null`。 */
  nodeId: string | null;
}

export const UNLINKED_SITE_SETTINGS: SiteSettingsLinkage = {
  siteNameLinkedToNode: false,
  siteUrlEditable: true,
  effectiveSiteUrl: null,
  nodeId: null,
};

export function siteSettingsLinkage(settings: SiteSettingsWithLinkage): SiteSettingsLinkage {
  return {
    siteNameLinkedToNode: settings.siteNameLinkedToNode === true,
    siteUrlEditable: settings.siteUrlEditable !== false,
    effectiveSiteUrl: settings.effectiveSiteUrl ?? null,
    nodeId: settings.nodeId ?? null,
  };
}

/** 草稿字段与 `UpdateSiteSettingsRequest` 同名同义，逐字段对比即可拼出增量。 */
const PATCH_KEYS = [
  'siteName',
  'siteUrl',
  'language',
  'bellThrottleSeconds',
  'notificationThrottleSeconds',
  'enableBrowserNotificationToast',
  'enableNotificationPush',
  'enableBellPush',
  'enableBellSound',
  'sshReconnectMaxRetries',
  'sshReconnectDelaySeconds',
] as const satisfies readonly (keyof SiteSettingsDraft)[];

/**
 * 只把与已保存值不同的字段放进 PATCH。mesh 模式下服务端会以 `site_url_managed` /
 * `site_name_managed` 拒绝被托管字段的**变更**，全量回传等于把整张表押在「值恰好没变」上。
 */
export function buildSiteSettingsPatch(
  baseline: SiteSettingsDraft,
  draft: SiteSettingsDraft,
  skip: ReadonlySet<keyof SiteSettingsDraft> = new Set()
): UpdateSiteSettingsRequest {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (skip.has(key) || baseline[key] === draft[key]) continue;
    patch[key] = draft[key];
  }
  return patch as UpdateSiteSettingsRequest;
}

export interface SiteSettingsSavePlan {
  /** 要经 hub 改的节点名（已 trim）；不改名时为 `null`。 */
  renameNodeTo: string | null;
  /** 站点设置的增量；没有字段变化时为 `null`。 */
  patch: UpdateSiteSettingsRequest | null;
}

/** 一次「保存」拆成的动作：联动的名字走 hub rename，其余字段走站点设置 PATCH。 */
export function planSiteSettingsSave(
  baseline: SiteSettingsDraft,
  draft: SiteSettingsDraft,
  linkage: SiteSettingsLinkage
): SiteSettingsSavePlan {
  const skip = new Set<keyof SiteSettingsDraft>();
  let renameNodeTo: string | null = null;
  if (linkage.siteNameLinkedToNode) {
    skip.add('siteName');
    const name = draft.siteName.trim();
    if (name && name !== baseline.siteName) renameNodeTo = name;
  }
  if (!linkage.siteUrlEditable) skip.add('siteUrl');
  const patch = buildSiteSettingsPatch(baseline, draft, skip);
  return { renameNodeTo, patch: Object.keys(patch).length > 0 ? patch : null };
}

export function hasSiteSettingsChanges(plan: SiteSettingsSavePlan): boolean {
  return plan.renameNodeTo !== null || plan.patch !== null;
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
  // 最近一次请求切换到的语言：语言包是异步加载的，切换在途时 i18n.language 还是旧值，
  // 若只看它，在途预览之后紧跟的回退会被当成「没变」而漏发
  let requestedLanguage: string | null = null;

  function switchTo(targetLanguage: LocaleCode | null | undefined): void {
    const next = resolveLanguageSwitch({
      controlsBrowserPrefs: options.controlsBrowserPrefs(),
      currentLanguage: requestedLanguage ?? options.currentLanguage(),
      targetLanguage,
    });
    if (next) {
      requestedLanguage = next;
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
