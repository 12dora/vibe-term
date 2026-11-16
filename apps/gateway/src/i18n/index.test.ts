import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureI18nLocale, i18next, isI18nLanguageReady, syncI18nLanguage, t } from './index';

type TranslationTree = { [key: string]: string | TranslationTree };

const LOCALES_DIR = join(import.meta.dir, '../../../../packages/shared/src/i18n/locales');

function sourceValue(lng: string, key: string): string | TranslationTree | undefined {
  const tree = JSON.parse(readFileSync(join(LOCALES_DIR, `${lng}.json`), 'utf8')).translation;
  return key
    .split('.')
    .reduce<string | TranslationTree | undefined>(
      (node, part) => (typeof node === 'object' ? node[part] : undefined),
      tree
    );
}

describe('i18n', () => {
  test('exports i18next instance', () => {
    expect(i18next).toBeDefined();
    expect(typeof i18next.t).toBe('function');
  });

  test('exports t function', () => {
    expect(t).toBeDefined();
    expect(typeof t).toBe('function');
  });

  test('t function translates keys', () => {
    const result = t('apiError.notFound');
    expect(result).toBe('Not found');
  });

  test('t function handles interpolation', () => {
    const result = t('sshError.reconnecting', { delay: 5, attempt: 1, maxRetries: 3 });
    expect(result).toContain('5');
    expect(result).toContain('1');
    expect(result).toContain('3');
  });

  test('default language is en_US', () => {
    expect(i18next.language).toBe('en_US');
  });

  test('只预载默认语言，且只含服务端 key', () => {
    expect(i18next.hasResourceBundle('en_US', 'translation')).toBe(true);
    expect(i18next.exists('apiError.notFound', { lng: 'en_US' })).toBe(true);
    expect(i18next.exists('settings.theme', { lng: 'en_US' })).toBe(false);
  });

  test('按需加载其他语言后按 lng 渲染源文案', async () => {
    for (const lng of ['zh_CN', 'ja_JP']) {
      await ensureI18nLocale(lng);
      expect(i18next.hasResourceBundle(lng, 'translation')).toBe(true);
      expect(t('apiError.notFound', { lng })).toBe(sourceValue(lng, 'apiError.notFound') as string);
    }
  });

  test('syncI18nLanguage 返回时语言包已就绪，未知语言回退默认语言', async () => {
    try {
      await syncI18nLanguage('ja_JP');
      expect(i18next.language).toBe('ja_JP');
      expect(i18next.hasResourceBundle('ja_JP', 'translation')).toBe(true);
      expect(isI18nLanguageReady('ja_JP')).toBe(true);
      expect(t('apiError.invalidRequest')).toBe(
        sourceValue('ja_JP', 'apiError.invalidRequest') as string
      );

      await syncI18nLanguage('fr_FR');
      expect(isI18nLanguageReady('fr_FR')).toBe(true);
      expect(t('apiError.notFound')).toBe('Not found');
    } finally {
      await syncI18nLanguage('en_US');
    }
    expect(isI18nLanguageReady('en_US')).toBe(true);
    expect(isI18nLanguageReady('zh_CN')).toBe(false);
  });
});
