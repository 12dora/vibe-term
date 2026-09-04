// 站点语言的浏览器级缓存：站点设置存在服务端，首屏（登录页也算）拿不到，
// 没有这份缓存就只能退回浏览器语言甚至 en_US 默认值，导致中文设备先渲染一屏英文。
// 键是浏览器级的裸 key（与 `tmex-ui` 同理），远端 node 的语言绝不写入。

import { type LocaleCode, SUPPORTED_LOCALES } from '@tmex/shared';

export const SITE_LANGUAGE_CACHE_KEY = 'tmex.site.language';

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && (SUPPORTED_LOCALES as string[]).includes(value);
}

export function readCachedSiteLanguage(): LocaleCode | null {
  try {
    const raw = localStorage.getItem(SITE_LANGUAGE_CACHE_KEY);
    return isLocaleCode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeCachedSiteLanguage(language: string): void {
  if (!isLocaleCode(language)) {
    return;
  }
  try {
    localStorage.setItem(SITE_LANGUAGE_CACHE_KEY, language);
  } catch {
    // localStorage 不可用（隐私模式 / 配额）时静默降级：缓存只是首屏加速，不是事实来源
  }
}
