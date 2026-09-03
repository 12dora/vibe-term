// 高亮体积护栏：未知语言超过 64 KiB、已知语言超过 512 KiB 时只渲染转义纯文本，
// 避免 highlightAuto 在大文件上把主线程卡住数秒。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import hljs from 'highlight.js/lib/core';
import { renderToStaticMarkup } from 'react-dom/server';

import { CodeViewer } from './code-viewer';

function render(code: string, fileName: string): string {
  return renderToStaticMarkup(<CodeViewer code={code} fileName={fileName} />);
}

const SNIPPET = 'const a = 1; // <tag>\n';

describe('CodeViewer 高亮护栏', () => {
  test('未知扩展名的小文件仍走自动识别', () => {
    expect(render(SNIPPET, 'notes.unknownext')).toContain('hljs-');
  });

  test('未知扩展名超过 64 KiB 时渲染转义纯文本', () => {
    const html = render(SNIPPET.repeat(4000), 'notes.unknownext');
    expect(html).not.toContain('hljs-');
    expect(html).toContain('&lt;tag&gt;');
  });

  test('已知语言在 64 KiB 以上仍然高亮', () => {
    expect(render(SNIPPET.repeat(4000), 'a.ts')).toContain('hljs-keyword');
  });

  test('已知语言超过 512 KiB 时渲染转义纯文本', () => {
    const html = render(SNIPPET.repeat(30_000), 'a.ts');
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('&lt;tag&gt;');
  });
});

// code-viewer 不再用 `highlight.js/lib/common`（CJS 构建，和 markdown 预览那条 lowlight 链的
// ESM 构建打不到一块去），改成自己按同一份清单往 `lib/core` 上注册。清单一旦跟上游漂了，
// highlightAuto 的候选集合与相关度排序就会变——所以直接读包里的 `lib/common.js` 对账，
// 升级 highlight.js 时这条会先红。注意**不能** import 那个入口，否则等于把语言注册进来。
const highlightJsDir = dirname(Bun.resolveSync('highlight.js/package.json', import.meta.dir));
const upstreamCommon = readFileSync(join(highlightJsDir, 'lib', 'common.js'), 'utf8');
const upstreamLanguages = [...upstreamCommon.matchAll(/registerLanguage\('([^']+)'/g)].map(
  (match) => match[1]
);

describe('CodeViewer 语言清单', () => {
  test('与 highlight.js/lib/common 同一套语言、同一注册顺序', () => {
    expect(upstreamLanguages.length).toBe(36);
    expect(hljs.listLanguages()).toEqual(upstreamLanguages);
  });
});
