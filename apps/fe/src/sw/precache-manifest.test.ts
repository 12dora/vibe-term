// 预缓存清单：首屏那批必须落进 core（缺一不可的 addAll），其余 chunk 落 lazy，
// 字体只取产物 CSS 静态声明的默认文件——generated 家族有 16 MB，绝不能混进来；
// 其中有 latin 子集垫底的完整面（每个 1.16 MB）再降一档到 lazy，弱网时随整档跳过。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPTIONAL_FONT_PREFIX,
  SHELL_PRECACHE_URL,
  buildPrecacheManifest,
  declaredFontUrls,
  emittedCssNames,
  htmlReferencedAssets,
  precacheAssetUrls,
  splitFontTiers,
} from './precache-manifest';

const HTML = `<!doctype html><html><head>
<link rel="manifest" href="/api/manifest.webmanifest" crossorigin="use-credentials" />
<link rel="apple-touch-icon" href="/vibeterm.png" />
<script type="module" crossorigin src="/assets/index-DBk6mNEt.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-7NC-AHOP.js">
<link rel="stylesheet" crossorigin href="/assets/index-DytZTuFF.css">
</head><body><div id="root"></div></body></html>`;

// 与 default-font-face.generated.css 同形：两个字重各一对（latin 子集 + 完整面）+ 符号字体
const CSS = `@font-face{font-family:GeistMonoVibeTerm;src:url("/fonts/GeistMonoNerdFontMono-Regular-latin.woff2") format("woff2")}
@font-face{font-family:GeistMonoVibeTerm;src:url("/fonts/GeistMonoNerdFontMono-Regular.woff2") format("woff2")}
@font-face{font-family:GeistMonoVibeTerm;src:url("/fonts/GeistMonoNerdFontMono-Bold-latin.woff2") format("woff2")}
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
  test('去重排序取全部默认字体（子集面与完整面都在内）', () => {
    expect(declaredFontUrls(CSS)).toEqual([
      '/fonts/GeistMonoNerdFontMono-Bold-latin.woff2',
      '/fonts/GeistMonoNerdFontMono-Bold.woff2',
      '/fonts/GeistMonoNerdFontMono-Regular-latin.woff2',
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

  test('显式剔掉 /fonts/generated/**（16 MB 可选家族只按需运行时缓存）', () => {
    const withOptional = `${CSS}
@font-face{font-family:FiraCodeVibeTerm;src:url("${OPTIONAL_FONT_PREFIX}fira-code/fira-code-regular.woff2") format("woff2")}`;
    expect(declaredFontUrls(withOptional)).toEqual(declaredFontUrls(CSS));
  });

  // 默认字体的四条 @font-face（子集面 / 完整面 × 两字重）由 `bun run build:fonts` 生成到
  // packages/theme，src/index.css 只 @import 它；这里跟着读生成物，口径与产物 CSS 一致。
  test('真实 index.css + 生成的 @font-face 恰好声明这五个默认字体文件', () => {
    const indexCss = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');
    const generated = readFileSync(
      join(import.meta.dir, '../../../../packages/theme/src/fonts/default-font-face.generated.css'),
      'utf8'
    );
    expect(declaredFontUrls(`${indexCss}\n${generated}`)).toEqual([
      '/fonts/GeistMonoNerdFontMono-Bold-latin.woff2',
      '/fonts/GeistMonoNerdFontMono-Bold.woff2',
      '/fonts/GeistMonoNerdFontMono-Regular-latin.woff2',
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

describe('splitFontTiers', () => {
  test('有 -latin 子集垫底的完整面才延后，其余一律首屏装', () => {
    const { eager, deferred } = splitFontTiers([
      '/fonts/A-latin.woff2',
      '/fonts/A.woff2',
      '/fonts/B.woff2',
    ]);
    expect(eager).toEqual(['/fonts/A-latin.woff2', '/fonts/B.woff2']);
    expect(deferred).toEqual(['/fonts/A.woff2']);
  });

  test('没有任何子集时全部首屏装（WP-B 之前的老产物）', () => {
    const urls = ['/fonts/A.woff2', '/fonts/B.woff2'];
    expect(splitFontTiers(urls)).toEqual({ eager: urls, deferred: [] });
  });

  test('子集自己不会被当成「完整面」延后', () => {
    expect(splitFontTiers(['/fonts/A-latin.woff2']).deferred).toEqual([]);
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

  test('lazy 是产物集合减去首屏集合（末尾接上延后的完整字体），与 core 不重叠', () => {
    expect(manifest.lazy).toEqual([
      '/assets/DevicePage-rBCXO5pj.js',
      '/assets/ghostty-vt-abc12345.wasm',
      '/fonts/GeistMonoNerdFontMono-Bold.woff2',
      '/fonts/GeistMonoNerdFontMono-Regular.woff2',
    ]);
    for (const url of manifest.lazy) expect(manifest.core).not.toContain(url);
  });

  test('fonts 只留首屏要的那几个：latin 子集 + 没有子集的符号字体', () => {
    expect(manifest.fonts).toEqual([
      '/fonts/GeistMonoNerdFontMono-Bold-latin.woff2',
      '/fonts/GeistMonoNerdFontMono-Regular-latin.woff2',
      '/fonts/NotoSansSymbols2-Regular.woff2',
    ]);
    expect(manifest.fonts.every((url) => !url.includes('/generated/'))).toBe(true);
  });

  test('1.16 MB 的完整面进 lazy 档（弱网可整档跳过，首个 PUA 图标时再取）', () => {
    expect(manifest.lazy).toContain('/fonts/GeistMonoNerdFontMono-Regular.woff2');
    expect(manifest.lazy).toContain('/fonts/GeistMonoNerdFontMono-Bold.woff2');
    for (const url of manifest.fonts) expect(manifest.lazy).not.toContain(url);
  });
});
