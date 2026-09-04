// 首屏语言解析：站点语言存在服务端，第一次绘制（登录页也算）时还没有任何请求回来，
// 所以只能靠「上次成功取到的站点语言缓存」+ 浏览器语言列表来定。
// 二者都拿不到才回落 manifest 默认语言。Web 与 PWA 走同一条路径，不看 display-mode。

import { DEFAULT_LOCALE, type LocaleCode } from '@tmex/shared';
import { readCachedSiteLanguage } from '@tmex/stores/site-language-cache';

const LANGUAGE_PREFIXES: ReadonlyArray<readonly [string, LocaleCode]> = [
  ['zh', 'zh_CN'],
  ['ja', 'ja_JP'],
  ['en', 'en_US'],
];

/** `zh-Hans-CN` / `ja` / `en-GB` 这类 BCP 47 标签映射到受支持的 locale。 */
export function matchBrowserTag(tag: string): LocaleCode | null {
  const normalized = tag.toLowerCase().replace(/_/g, '-');
  const primary = normalized.split('-')[0] ?? '';
  return LANGUAGE_PREFIXES.find(([prefix]) => prefix === primary)?.[1] ?? null;
}

/** navigator.languages 优先（按用户排序），老浏览器退回 navigator.language。 */
export function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') {
    return [];
  }
  const list = navigator.languages;
  if (Array.isArray(list) && list.length > 0) {
    return list.filter((tag): tag is string => typeof tag === 'string');
  }
  return typeof navigator.language === 'string' ? [navigator.language] : [];
}

export interface InitialLanguageInput {
  /** 上次成功取到的站点语言；缺省读 localStorage 缓存 */
  cached?: LocaleCode | null;
  /** 浏览器语言标签，按优先级排序；缺省读 navigator */
  languages?: readonly string[];
}

export function resolveInitialLanguage(input: InitialLanguageInput = {}): LocaleCode {
  const cached = input.cached === undefined ? readCachedSiteLanguage() : input.cached;
  if (cached) {
    return cached;
  }
  const languages = input.languages ?? browserLanguages();
  for (const tag of languages) {
    const matched = matchBrowserTag(tag);
    if (matched) {
      return matched;
    }
  }
  return DEFAULT_LOCALE;
}
