// 预缓存清单：首屏那批必须落进 core（缺一不可的 addAll），其余 chunk 落 lazy，
// 字体只取 index.css 静态声明的三个默认文件——generated 家族有 16 MB，绝不能混进来。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHELL_PRECACHE_URL,
  buildPrecacheManifest,
  declaredFontUrls,
  emittedCssNames,
  htmlReferencedAssets,
  precacheAssetUrls,
} from './precache-manifest';

const HTML = `<!doctype html><html><head>
<link rel="manifest" href="/api/manifest.webmanifest" crossorigin="use-credentials" />
<link rel="apple-touch-icon" href="/vibeterm.png" />
<script type="module" crossorigin src="/assets/index-DBk6mNEt.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-7NC-AHOP.js">
<link rel="stylesheet" crossorigin href="/assets/index-DytZTuFF.css">
</head><body><div id="root"></div></body></html>`;

const CSS = `@font-face{font-family:GeistMonoVibeTerm;src:url("/fonts/GeistMonoNerdFontMono-Regular.woff2") format("woff2")}
@font-face{font-family:GeistMonoVibeTerm;src:url("/fonts/GeistMonoNerdFontMono-Bold.woff2") format("woff2")}
@font-face{font-family:NotoSansSymbols2VibeTerm;src:url("/fonts/NotoSansSymbols2-Regular.woff2") format("woff2")}`;

describe('htmlReferencedAssets', () => {
  test('收入口脚本、modulepreload 与样式表', () => {
    expect(htmlReferencedAssets(HTML)).toEqual([
      '/assets/index-DBk6mNEt.js',
      '/assets/index-DytZTuFF.css',
      '/assets/vendor-react-7NC-AHOP.js',
    ]);
  });

  test('不收 manifest / 图标等非 assets 引用', () => {
    const refs = htmlReferencedAssets(HTML);
    expect(refs.some((url) => url.includes('manifest'))).toBe(false);
    expect(refs).not.toContain('/vibeterm.png');
  });

  test('没有首屏引用时返回空数组', () => {
    expect(htmlReferencedAssets('<html><body></body></html>')).toEqual([]);
  });
});

describe('declaredFontUrls', () => {
  test('去重排序取三个默认字体', () => {
    expect(declaredFontUrls(CSS)).toEqual([
      '/fonts/GeistMonoNerdFontMono-Bold.woff2',
      '/fonts/GeistMonoNerdFontMono-Regular.woff2',
      '/fonts/NotoSansSymbols2-Regular.woff2',
    ]);
  });

  test('不含 generated 家族时结果不受影响', () => {
    expect(declaredFontUrls('body{}')).toEqual([]);
  });

  test('多份产物 CSS 拼在一起时去重（同一个 @font-face 只算一次）', () => {
    expect(declaredFontUrls(`${CSS}\n${CSS}`)).toEqual(declaredFontUrls(CSS));
  });

  test('真实 src/index.css 恰好声明这三个默认字体', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');
    expect(declaredFontUrls(css)).toEqual([
      '/fonts/GeistMonoNerdFontMono-Bold.woff2',
      '/fonts/GeistMonoNerdFontMono-Regular.woff2',
      '/fonts/NotoSansSymbols2-Regular.woff2',
    ]);
  });
});

describe('emittedCssNames', () => {
  test('只收 assets/ 下的样式表并排序', () => {
    expect(
      emittedCssNames([
        'index.html',
        'assets/z-11111111.css',
        'assets/a-22222222.css',
        'assets/index-33333333.js',
        'sw.js',
      ])
    ).toEqual(['assets/a-22222222.css', 'assets/z-11111111.css']);
  });
});

describe('precacheAssetUrls', () => {
  test('只收 assets/ 下的 js / css / wasm', () => {
    expect(
      precacheAssetUrls([
        'index.html',
        'assets/index-DBk6mNEt.js',
        'assets/index-DytZTuFF.css',
        'assets/ghostty-vt-abc12345.wasm',
        'assets/logo-abc12345.png',
        'assets/index-DBk6mNEt.js.map',
        'sw.js',
        'fonts/GeistMonoNerdFontMono-Regular.woff2',
      ])
    ).toEqual([
      '/assets/ghostty-vt-abc12345.wasm',
      '/assets/index-DBk6mNEt.js',
      '/assets/index-DytZTuFF.css',
    ]);
  });
});

describe('buildPrecacheManifest', () => {
  const manifest = buildPrecacheManifest({
    html: HTML,
    bundleNames: [
      'index.html',
      'assets/index-DBk6mNEt.js',
      'assets/vendor-react-7NC-AHOP.js',
      'assets/index-DytZTuFF.css',
      'assets/DevicePage-rBCXO5pj.js',
      'assets/ghostty-vt-abc12345.wasm',
    ],
    css: CSS,
  });

  test('core 以应用壳开头并覆盖全部首屏引用', () => {
    expect(manifest.core[0]).toBe(SHELL_PRECACHE_URL);
    expect(manifest.core).toContain('/assets/index-DBk6mNEt.js');
    expect(manifest.core).toContain('/assets/vendor-react-7NC-AHOP.js');
    expect(manifest.core).toContain('/assets/index-DytZTuFF.css');
  });

  test('lazy 是产物集合减去首屏集合，两者不重叠', () => {
    expect(manifest.lazy).toEqual([
      '/assets/DevicePage-rBCXO5pj.js',
      '/assets/ghostty-vt-abc12345.wasm',
    ]);
    for (const url of manifest.lazy) expect(manifest.core).not.toContain(url);
  });

  test('fonts 只有三个默认字体', () => {
    expect(manifest.fonts).toHaveLength(3);
    expect(manifest.fonts.every((url) => !url.includes('/generated/'))).toBe(true);
  });
});
