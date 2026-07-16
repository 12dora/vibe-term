import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FONT_ID, FONT_MANIFEST, getFontEntry, resolveFontStack } from './fonts/index';

const themeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(themeRoot, '../..');
const packageJson = await Bun.file(path.join(themeRoot, 'package.json')).json();

function listFontFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...listFontFiles(abs));
    } else if (name.endsWith('.woff2')) {
      out.push(abs);
    }
  }
  return out;
}

describe('@tmex/theme package exports', () => {
  test('export map 覆盖 font API/manifest/types、CSS 与 fonts resource 子路径', () => {
    const exports = packageJson.exports as Record<string, string>;
    expect(exports['./fonts']).toBe('./src/fonts/index.ts');
    expect(exports['./fonts/manifest']).toBe('./src/fonts/manifest.generated.ts');
    expect(exports['./fonts/types']).toBe('./src/fonts/types.ts');
    expect(exports['./themes.css']).toBe('./src/themes.css');
    expect(exports['./tokens.css']).toBe('./src/tokens.css');
    expect(exports['./tokens.generated.css']).toBe('./src/tokens.generated.css');
    expect(exports['./resources/fonts/*']).toBe('./resources/fonts/*');
  });

  test('export 目标存在且 font API/manifest 可解析', async () => {
    const exports = packageJson.exports as Record<string, string>;
    for (const [key, rel] of Object.entries(exports)) {
      if (key.includes('*') || key === './*') continue;
      expect(existsSync(path.join(themeRoot, rel))).toBe(true);
    }

    const fonts = await import('@tmex/theme/fonts');
    expect(fonts.DEFAULT_FONT_ID).toBe(DEFAULT_FONT_ID);
    expect(fonts.FONT_MANIFEST.length).toBeGreaterThan(0);

    const manifest = await import('@tmex/theme/fonts/manifest');
    expect(manifest.FONT_MANIFEST.length).toBe(FONT_MANIFEST.length);

    const types = await import('@tmex/theme/fonts/types');
    expect(types).toBeDefined();

    expect(getFontEntry(DEFAULT_FONT_ID).isDefault).toBe(true);
    expect(resolveFontStack(DEFAULT_FONT_ID)).toContain('monospace');
  });
});

describe('font binary ownership', () => {
  test('15 个 woff2 仅存在于 packages/theme/resources/fonts', () => {
    const resourceFonts = path.join(themeRoot, 'resources/fonts');
    const files = listFontFiles(resourceFonts);
    expect(files).toHaveLength(15);

    // apps/fe/public/fonts 必须是指向 package resources 的相对 symlink，不是第二套二进制
    const feFonts = path.join(repoRoot, 'apps/fe/public/fonts');
    expect(lstatSync(feFonts).isSymbolicLink()).toBe(true);
    const target = readlinkSync(feFonts);
    expect(target).toBe('../../../packages/theme/resources/fonts');
    expect(existsSync(path.join(feFonts, 'GeistMonoNerdFontMono-Regular.woff2'))).toBe(true);
    expect(
      existsSync(path.join(feFonts, 'generated/jetbrains-mono/jetbrains-mono-regular.woff2'))
    ).toBe(true);
  });
});
