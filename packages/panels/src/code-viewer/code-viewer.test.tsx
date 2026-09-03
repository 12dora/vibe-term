// CodeViewer 渲染契约：高亮不在渲染路径上——首帧永远是纯文本，高亮由 worker 回来后再换。
// 体积护栏（未知语言 > 64 KiB、已知语言 > 512 KiB）保持不变，超限文件按行块 + content-visibility 渲染。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { BUNDLED_LANGUAGES } from './bundled-languages';
import { CodeViewer } from './code-viewer';
import { LANGUAGE_LOADERS } from './language-loaders';
import { AUTO_DETECT_LANGUAGES, COMMON_LANGUAGE_NAMES, planHighlight } from './language-map';

function render(code: string, fileName: string): string {
  return renderToStaticMarkup(<CodeViewer code={code} fileName={fileName} />);
}

const SNIPPET = 'const a = 1; // <tag>\n';

describe('CodeViewer 首帧', () => {
  test('高亮回来之前渲染纯文本', () => {
    const html = render(SNIPPET, 'a.ts');
    expect(html).not.toContain('hljs-');
    expect(html).toContain('const a = 1; // &lt;tag&gt;');
  });

  test('行号栏与行数一致', () => {
    const html = render('a\nb\nc\n', 'a.ts');
    expect(html).toContain('1\n2\n3\n4');
  });
});

describe('CodeViewer 高亮护栏', () => {
  test('未知扩展名的小文件计划走自动识别', () => {
    expect(planHighlight(SNIPPET.length, 'notes.unknownext')).toEqual({ mode: 'auto' });
  });

  test('未知扩展名超过 64 KiB 直接判定为纯文本', () => {
    const code = SNIPPET.repeat(4000);
    expect(planHighlight(code.length, 'notes.unknownext')).toEqual({ mode: 'plain' });
    const html = render(code, 'notes.unknownext');
    expect(html).not.toContain('hljs-');
    expect(html).toContain('&lt;tag&gt;');
  });

  test('已知语言在 64 KiB 以上仍计划高亮', () => {
    expect(planHighlight(SNIPPET.repeat(4000).length, 'a.ts')).toEqual({
      mode: 'language',
      language: 'typescript',
    });
  });

  test('已知语言超过 512 KiB 判定为纯文本，并按行块渲染', () => {
    const code = SNIPPET.repeat(30_000);
    expect(planHighlight(code.length, 'a.ts')).toEqual({ mode: 'plain' });
    const html = render(code, 'a.ts');
    expect(html).not.toContain('hljs-');
    expect(html).toContain('&lt;tag&gt;');
    // 30001 行 / 每块 500 行 = 61 个块，屏外块靠 content-visibility 跳过布局。
    expect(html.split('content-visibility:auto').length - 1).toBe(61);
    expect(html).toContain('contain-intrinsic-height:auto 9750.0px');
  });
});

// 语言清单一旦跟上游漂了，highlightAuto 的候选集合与相关度排序就会变——直接读包里的
// `lib/common.js` 对账，升级 highlight.js 时这条会先红。注意**不能** import 那个入口，
// 否则等于把 38 个语言重新静态拉进来。
const highlightJsDir = dirname(Bun.resolveSync('highlight.js/package.json', import.meta.dir));
const upstreamCommon = readFileSync(join(highlightJsDir, 'lib', 'common.js'), 'utf8');
const upstreamLanguages = [...upstreamCommon.matchAll(/registerLanguage\('([^']+)'/g)].map(
  (match) => match[1]
);

describe('CodeViewer 语言清单', () => {
  test('与 highlight.js/lib/common 同一套语言、同一注册顺序', () => {
    expect(upstreamLanguages.length).toBe(36);
    expect(COMMON_LANGUAGE_NAMES.join()).toBe(upstreamLanguages.join());
    expect(Object.keys(LANGUAGE_LOADERS)).toEqual(upstreamLanguages);
    expect(Object.keys(BUNDLED_LANGUAGES)).toEqual(upstreamLanguages);
  });

  test('自动识别子集全部有加载器，且规模远小于全集', () => {
    for (const name of AUTO_DETECT_LANGUAGES) {
      expect(LANGUAGE_LOADERS[name]).toBeDefined();
      expect(BUNDLED_LANGUAGES[name]).toBeDefined();
    }
    expect(AUTO_DETECT_LANGUAGES.length).toBeLessThan(upstreamLanguages.length / 2);
  });
});
