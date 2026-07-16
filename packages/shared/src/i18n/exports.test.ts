import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = await Bun.file(path.join(pkgRoot, 'package.json')).json();

describe('@tmex/shared i18n package exports', () => {
  test('export map 覆盖 resources/types/manifest 与三语 JSON', () => {
    const exports = packageJson.exports as Record<string, string>;
    expect(exports['./i18n/resources']).toBe('./src/i18n/resources.ts');
    expect(exports['./i18n/types']).toBe('./src/i18n/types.ts');
    expect(exports['./i18n/locales/manifest.json']).toBe('./src/i18n/locales/manifest.json');
    expect(exports['./i18n/locales/en_US.json']).toBe('./src/i18n/locales/en_US.json');
    expect(exports['./i18n/locales/zh_CN.json']).toBe('./src/i18n/locales/zh_CN.json');
    expect(exports['./i18n/locales/ja_JP.json']).toBe('./src/i18n/locales/ja_JP.json');
  });

  test('export 目标文件全部存在且可 import', async () => {
    const exports = packageJson.exports as Record<string, string>;
    for (const rel of Object.values(exports)) {
      const abs = path.join(pkgRoot, rel);
      expect(existsSync(abs)).toBe(true);
    }

    const resources = await import('@tmex/shared/i18n/resources');
    expect(resources.DEFAULT_LOCALE).toBeDefined();
    expect(resources.I18N_RESOURCES).toBeDefined();

    const typesMod = await import('@tmex/shared/i18n/types');
    expect(typesMod).toBeDefined();

    const en = await import('@tmex/shared/i18n/locales/en_US.json');
    const zh = await import('@tmex/shared/i18n/locales/zh_CN.json');
    const ja = await import('@tmex/shared/i18n/locales/ja_JP.json');
    const manifest = await import('@tmex/shared/i18n/locales/manifest.json');
    expect(en.default ?? en).toBeTruthy();
    expect(zh.default ?? zh).toBeTruthy();
    expect(ja.default ?? ja).toBeTruthy();
    expect((manifest.default ?? manifest).locales?.length).toBeGreaterThan(0);
  });
});
