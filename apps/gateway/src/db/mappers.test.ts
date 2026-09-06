// 站点语言归一化：清单里的三种语言都要能存下来（此前只认 zh_CN，选日文会静默落回英文）。

import { describe, expect, test } from 'bun:test';
import { DEFAULT_LOCALE, I18N_MANIFEST, type LocaleCode } from '@vibeterm/shared';
import { normalizeLocale } from './mappers';

describe('normalizeLocale', () => {
  test('清单里的每种语言原样保留', () => {
    for (const locale of I18N_MANIFEST.locales) {
      expect(normalizeLocale(locale.code)).toBe(locale.code as LocaleCode);
    }
    expect(normalizeLocale('ja_JP')).toBe('ja_JP');
  });

  test('空值与未知值落回默认语言', () => {
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('fr_FR')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale('zh-CN')).toBe(DEFAULT_LOCALE);
  });
});
