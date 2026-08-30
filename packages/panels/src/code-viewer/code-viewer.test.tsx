// 高亮体积护栏：未知语言超过 64 KiB、已知语言超过 512 KiB 时只渲染转义纯文本，
// 避免 highlightAuto 在大文件上把主线程卡住数秒。

import { describe, expect, test } from 'bun:test';
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
