import { afterEach, describe, expect, test } from 'bun:test';
import { SITE_LANGUAGE_CACHE_KEY } from '@tmex/stores/site-language-cache';
import { browserLanguages, matchBrowserTag, resolveInitialLanguage } from './initial-language';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function stubNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function stubLocalStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function restore(key: 'navigator' | 'localStorage', descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, key);
  }
}

afterEach(() => {
  restore('navigator', originalNavigator);
  restore('localStorage', originalLocalStorage);
});

describe('matchBrowserTag', () => {
  test('按主语言子标签匹配，忽略地区与书写系统', () => {
    expect(matchBrowserTag('zh')).toBe('zh_CN');
    expect(matchBrowserTag('zh-CN')).toBe('zh_CN');
    expect(matchBrowserTag('zh-Hans-CN')).toBe('zh_CN');
    expect(matchBrowserTag('zh-TW')).toBe('zh_CN');
    expect(matchBrowserTag('ja-JP')).toBe('ja_JP');
    expect(matchBrowserTag('en-GB')).toBe('en_US');
    expect(matchBrowserTag('zh_CN')).toBe('zh_CN');
  });

  test('不支持的语言返回 null，不误伤前缀相同的其它标签', () => {
    expect(matchBrowserTag('de-DE')).toBeNull();
    expect(matchBrowserTag('ko')).toBeNull();
    expect(matchBrowserTag('eng')).toBeNull();
    expect(matchBrowserTag('')).toBeNull();
  });
});

describe('browserLanguages', () => {
  test('优先取 navigator.languages（按用户排序）', () => {
    stubNavigator({ languages: ['ja-JP', 'en-US'], language: 'en-US' });
    expect(browserLanguages()).toEqual(['ja-JP', 'en-US']);
  });

  test('没有 languages 时退回 navigator.language', () => {
    stubNavigator({ language: 'zh-CN' });
    expect(browserLanguages()).toEqual(['zh-CN']);
  });

  test('languages 为空数组时也退回 navigator.language', () => {
    stubNavigator({ languages: [], language: 'ja' });
    expect(browserLanguages()).toEqual(['ja']);
  });
});

describe('resolveInitialLanguage', () => {
  test('navigator.languages 按顺序命中第一个受支持的语言', () => {
    expect(resolveInitialLanguage({ cached: null, languages: ['de-DE', 'zh-CN', 'en-US'] })).toBe(
      'zh_CN'
    );
    expect(resolveInitialLanguage({ cached: null, languages: ['ko-KR', 'ja', 'zh-CN'] })).toBe(
      'ja_JP'
    );
  });

  test('全部不支持时回落 manifest 默认语言', () => {
    expect(resolveInitialLanguage({ cached: null, languages: ['de-DE', 'ko-KR'] })).toBe('en_US');
    expect(resolveInitialLanguage({ cached: null, languages: [] })).toBe('en_US');
  });

  test('缓存的站点语言优先于浏览器语言', () => {
    expect(resolveInitialLanguage({ cached: 'ja_JP', languages: ['zh-CN'] })).toBe('ja_JP');
    expect(resolveInitialLanguage({ cached: 'en_US', languages: ['zh-CN'] })).toBe('en_US');
  });

  test('缺省参数时读 localStorage 缓存与 navigator', () => {
    stubLocalStorage(memoryStorage({ [SITE_LANGUAGE_CACHE_KEY]: 'ja_JP' }));
    stubNavigator({ languages: ['zh-CN'] });
    expect(resolveInitialLanguage()).toBe('ja_JP');

    stubLocalStorage(memoryStorage());
    expect(resolveInitialLanguage()).toBe('zh_CN');
  });

  test('localStorage 抛异常时不崩，退回浏览器语言', () => {
    stubLocalStorage({
      getItem: () => {
        throw new Error('denied');
      },
    });
    stubNavigator({ languages: ['zh-Hans-CN'] });
    expect(resolveInitialLanguage()).toBe('zh_CN');
  });

  test('缓存里是垃圾值时忽略，退回浏览器语言', () => {
    stubLocalStorage(memoryStorage({ [SITE_LANGUAGE_CACHE_KEY]: 'fr_FR' }));
    stubNavigator({ languages: ['ja-JP'] });
    expect(resolveInitialLanguage()).toBe('ja_JP');
  });
});
