// 默认终端字体的两段分片守卫。
//
// 这是「终端首帧不再等 2.3 MB」的全部前提，任何一条回归都会让冷启动重新变成 20 秒：
//  · manifest 必须带 subset 四件套，产物必须在库里且足够小；
//  · 两个 unicode-range 必须互不相交（相交的话浏览器可能为拉丁字符去拉完整文件）；
//  · 生成的 @font-face 必须与 manifest 完全一致（CSS 手写就一定会漂移）；
//  · 首帧样本文本必须整个落在子集范围内，二段样本必须落在完整面那一侧。

import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FONT_ID,
  FIRST_PAINT_SAMPLE_TEXT,
  getFontEntry,
  sampleTextForRange,
} from './index';
import type { FontSubsetFiles } from './types';

const fontsDir = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(fontsDir, '../../resources/fonts');
const GENERATED_CSS = path.join(fontsDir, 'default-font-face.generated.css');

/** 每字重子集上限：再大就说明 LATIN_SUBSET_RANGES 被放宽到不该有的区段 */
const SUBSET_MAX_BYTES = 120 * 1024;

const defaultEntry = getFontEntry(DEFAULT_FONT_ID);

function subsetOrFail(): FontSubsetFiles {
  const subset = defaultEntry.subset;
  if (!subset) throw new Error('默认字体缺少 subset —— 先跑 bun run build:fonts');
  return subset;
}

function parseRange(unicodeRange: string): [number, number][] {
  return unicodeRange.split(',').map((part) => {
    const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/.exec(part.trim());
    if (!match) throw new Error(`无法解析 unicode-range 片段：${part}`);
    const start = Number.parseInt(match[1] as string, 16);
    return [start, match[2] ? Number.parseInt(match[2], 16) : start];
  });
}

function covers(ranges: readonly [number, number][], cp: number): boolean {
  return ranges.some(([start, end]) => cp >= start && cp <= end);
}

function resourceFile(url: string): string {
  return path.join(RESOURCES, url.replace(/^\/fonts\//, ''));
}

describe('默认终端字体的 latin 子集', () => {
  test('manifest 带 subset 四件套，且 URL 指向 /fonts 下的产物', () => {
    const subset = subsetOrFail();
    expect(subset.regular).toBe('/fonts/GeistMonoNerdFontMono-Regular-latin.woff2');
    expect(subset.bold).toBe('/fonts/GeistMonoNerdFontMono-Bold-latin.woff2');
    expect(subset.unicodeRange.length).toBeGreaterThan(0);
    expect(subset.fullUnicodeRange.length).toBeGreaterThan(0);
  });

  test('子集产物每字重都远小于完整文件（首帧只等这一段）', () => {
    const subset = subsetOrFail();
    const files = defaultEntry.files;
    if (!files) throw new Error('默认字体缺少 files');
    for (const url of [subset.regular, subset.bold]) {
      expect(statSync(resourceFile(url)).size).toBeLessThan(SUBSET_MAX_BYTES);
    }
    for (const url of [files.regular, files.bold]) {
      expect(statSync(resourceFile(url)).size).toBeGreaterThan(SUBSET_MAX_BYTES * 4);
    }
  });

  test('两个 unicode-range 互不相交', () => {
    const subset = subsetOrFail();
    const subsetRanges = parseRange(subset.unicodeRange);
    for (const [start, end] of parseRange(subset.fullUnicodeRange)) {
      expect(covers(subsetRanges, start)).toBe(false);
      expect(covers(subsetRanges, end)).toBe(false);
    }
  });

  test('首帧样本文本整个落在子集范围内', () => {
    const ranges = parseRange(subsetOrFail().unicodeRange);
    for (const char of [...FIRST_PAINT_SAMPLE_TEXT]) {
      expect({ char, covered: covers(ranges, char.codePointAt(0) as number) }).toEqual({
        char,
        covered: true,
      });
    }
  });

  test('二段样本字符只落在完整面那一侧', () => {
    const subset = subsetOrFail();
    const sample = sampleTextForRange(subset.fullUnicodeRange);
    expect(sample).not.toBeNull();
    const cp = (sample as string).codePointAt(0) as number;
    expect(covers(parseRange(subset.fullUnicodeRange), cp)).toBe(true);
    expect(covers(parseRange(subset.unicodeRange), cp)).toBe(false);
  });

  test('常用制表 / 块元素 / Powerline 字形都在子集里（提示符不会先错位再跳变）', () => {
    const ranges = parseRange(subsetOrFail().unicodeRange);
    for (const cp of [0x41, 0x2500, 0x2502, 0x2588, 0x2591, 0xe0b0, 0xe0a0]) {
      expect({ cp, covered: covers(ranges, cp) }).toEqual({ cp, covered: true });
    }
  });
});

describe('生成的 @font-face', () => {
  test('四条面与 manifest 完全一致：子集两字重 + 完整两字重', async () => {
    const subset = subsetOrFail();
    const files = defaultEntry.files;
    if (!files) throw new Error('默认字体缺少 files');
    const css = await Bun.file(GENERATED_CSS).text();

    const faces = css.split('@font-face').slice(1);
    expect(faces).toHaveLength(4);
    for (const face of faces) {
      expect(face).toContain(`font-family: ${defaultEntry.cssFamily};`);
      expect(face).toContain('font-display: swap;');
    }

    const expected: ReadonlyArray<readonly [string, number, string]> = [
      [subset.regular, 400, subset.unicodeRange],
      [subset.bold, 700, subset.unicodeRange],
      [files.regular, 400, subset.fullUnicodeRange],
      [files.bold, 700, subset.fullUnicodeRange],
    ];
    expected.forEach(([url, weight, range], index) => {
      const face = faces[index] as string;
      expect(face).toContain(`url("${url}")`);
      expect(face).toContain(`font-weight: ${weight};`);
      expect(face).toContain(`unicode-range: ${range};`);
    });
  });

  test('apps/fe 只 @import 生成物，不再手写默认字体的 @font-face', async () => {
    const indexCss = await Bun.file(
      path.resolve(fontsDir, '../../../../apps/fe/src/index.css')
    ).text();
    expect(indexCss).toContain('packages/theme/src/fonts/default-font-face.generated.css');
    expect(indexCss).not.toContain('GeistMonoNerdFontMono-Regular.woff2');
  });
});
