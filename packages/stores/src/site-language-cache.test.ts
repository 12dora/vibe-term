import { afterEach, describe, expect, test } from 'bun:test';
import {
  SITE_LANGUAGE_CACHE_KEY,
  isLocaleCode,
  readCachedSiteLanguage,
  writeCachedSiteLanguage,
} from './site-language-cache';
import { createMemoryStorage } from './test-utils';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function stub(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

afterEach(() => {
  if (original) {
    Object.defineProperty(globalThis, 'localStorage', original);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('站点语言缓存', () => {
  test('写入后可读回', () => {
    stub(createMemoryStorage());
    writeCachedSiteLanguage('zh_CN');
    expect(localStorage.getItem(SITE_LANGUAGE_CACHE_KEY)).toBe('zh_CN');
    expect(readCachedSiteLanguage()).toBe('zh_CN');
  });

  test('非受支持的语言不写入，也读不出来', () => {
    stub(createMemoryStorage());
    writeCachedSiteLanguage('fr_FR');
    expect(localStorage.getItem(SITE_LANGUAGE_CACHE_KEY)).toBeNull();

    localStorage.setItem(SITE_LANGUAGE_CACHE_KEY, 'fr_FR');
    expect(readCachedSiteLanguage()).toBeNull();
  });

  test('localStorage 不可用时读写都静默降级', () => {
    stub({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readCachedSiteLanguage()).toBeNull();
    expect(() => writeCachedSiteLanguage('ja_JP')).not.toThrow();
  });

  test('isLocaleCode 只认 manifest 里的语言', () => {
    expect(isLocaleCode('en_US')).toBe(true);
    expect(isLocaleCode('zh_CN')).toBe(true);
    expect(isLocaleCode('ja_JP')).toBe(true);
    expect(isLocaleCode('zh-CN')).toBe(false);
    expect(isLocaleCode(null)).toBe(false);
    expect(isLocaleCode(undefined)).toBe(false);
  });
});
