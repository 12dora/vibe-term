// 语言包一致性：三种语言的 key 集合必须一致，且 `bun run build:i18n` 的生成物（resources.ts
// 与 locales/generated/*.json）必须与 locales/*.json 同步。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { I18N_CORE_KEY_PREFIXES, isCoreI18nKey, splitTranslation } from './core-keys';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from './locales/generated/meta';
import {
  SERVER_I18N_FALLBACK,
  SERVER_I18N_FALLBACK_LOCALE,
  SERVER_I18N_LOADERS,
} from './locales/generated/server';
import { I18N_RESOURCES } from './resources';
import { pickServerTranslation } from './server-keys';

type TranslationTree = { [key: string]: string | TranslationTree };

const LOCALES_DIR = join(import.meta.dir, 'locales');
const LOCALES = ['en_US', 'zh_CN', 'ja_JP'] as const;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function readJson(file: string): { translation: TranslationTree } {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function leafKeys(tree: TranslationTree, prefix = '', out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push(full);
    else leafKeys(value, full, out);
  }
  return out;
}

const source = Object.fromEntries(
  LOCALES.map((lng) => [lng, readJson(join(LOCALES_DIR, `${lng}.json`)).translation])
) as Record<(typeof LOCALES)[number], TranslationTree>;

describe('i18n locales', () => {
  test('三种语言的 key 集合一致（复数后缀归一后比较）', () => {
    // zh_CN / ja_JP 只有一种复数形态，写裸 key 由 i18next 回退命中，属预期差异。
    const normalized = (lng: (typeof LOCALES)[number]) =>
      [...new Set(leafKeys(source[lng]).map((key) => key.replace(PLURAL_SUFFIX, '')))].sort();

    const reference = normalized('en_US');
    expect(reference.length).toBeGreaterThan(1000);
    for (const lng of LOCALES)
      expect({ lng, keys: normalized(lng) }).toEqual({ lng, keys: reference });
  });

  test('每个 key 的值都是非空字符串', () => {
    for (const lng of LOCALES) {
      const blank = leafKeys(source[lng]).filter((key) => {
        const value = key
          .split('.')
          .reduce<string | TranslationTree | undefined>(
            (node, part) => (typeof node === 'object' ? node[part] : undefined),
            source[lng]
          );
        return typeof value !== 'string' || value.trim() === '';
      });
      expect({ lng, blank }).toEqual({ lng, blank: [] });
    }
  });

  test('resources.ts 与 locales/*.json 同步', () => {
    for (const lng of LOCALES) {
      const generated = I18N_RESOURCES[lng].translation as unknown as TranslationTree;
      expect({ lng, tree: generated }).toEqual({ lng, tree: source[lng] });
    }
  });

  test('locales/generated 的 core/rest 与源文件、前缀表同步', () => {
    for (const lng of LOCALES) {
      const { core, rest } = splitTranslation(source[lng]);
      const onDiskCore = readJson(join(LOCALES_DIR, 'generated', `${lng}.core.json`)).translation;
      const onDiskRest = readJson(join(LOCALES_DIR, 'generated', `${lng}.rest.json`)).translation;
      expect({ lng, core: onDiskCore }).toEqual({ lng, core });
      expect({ lng, rest: onDiskRest }).toEqual({ lng, rest });

      const coreLeaves = leafKeys(onDiskCore);
      const restLeaves = leafKeys(onDiskRest);
      expect([...coreLeaves, ...restLeaves].sort()).toEqual(leafKeys(source[lng]).sort());
      expect(coreLeaves.every(isCoreI18nKey)).toBe(true);
      expect(restLeaves.some(isCoreI18nKey)).toBe(false);
    }
  });

  test('locales/generated 的 meta 与 manifest 同步', () => {
    const manifest = JSON.parse(readFileSync(join(LOCALES_DIR, 'manifest.json'), 'utf8'));
    expect(DEFAULT_LOCALE).toBe(manifest.defaultLocale);
    expect([...AVAILABLE_LOCALES].sort()).toEqual([...LOCALES].sort());
  });

  test('locales/generated 的服务端语言包与源文件、前缀表同步', async () => {
    expect(SERVER_I18N_FALLBACK_LOCALE).toBe(DEFAULT_LOCALE);
    expect(SERVER_I18N_FALLBACK).toEqual(pickServerTranslation(source[DEFAULT_LOCALE]));
    for (const lng of LOCALES) {
      if (lng === DEFAULT_LOCALE) {
        expect(SERVER_I18N_LOADERS[lng]).toBeUndefined();
        continue;
      }
      const load = SERVER_I18N_LOADERS[lng];
      expect(load).toBeDefined();
      const mod = await load?.();
      const expected = pickServerTranslation(source[lng]);
      expect({ lng, tree: mod?.default }).toEqual({ lng, tree: expected });
    }
  });

  test('core 前缀表本身没有死条目', () => {
    const all = new Set(leafKeys(source.en_US));
    for (const prefix of I18N_CORE_KEY_PREFIXES) {
      const hit = [...all].some((key) => key === prefix || key.startsWith(`${prefix}.`));
      expect(`${prefix}:${hit}`).toBe(`${prefix}:true`);
    }
  });
});
