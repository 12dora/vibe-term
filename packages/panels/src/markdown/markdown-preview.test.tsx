import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownPreview, resolveImgSrc, skipsAutoDetect } from './markdown-preview';

const resolver = (absPath: string) =>
  `/api/files/raw?rootId=r1&path=${encodeURIComponent(absPath)}`;

describe('resolveImgSrc', () => {
  it('外链与 data URI 原样返回', () => {
    expect(resolveImgSrc('https://cdn.example.com/a.png', '/docs', resolver)).toBe(
      'https://cdn.example.com/a.png'
    );
    expect(resolveImgSrc('//cdn.example.com/a.png', '/docs', resolver)).toBe(
      '//cdn.example.com/a.png'
    );
    expect(resolveImgSrc('data:image/png;base64,AA', '/docs', resolver)).toBe(
      'data:image/png;base64,AA'
    );
  });

  it('未注入 resolver 时不改写本地 src', () => {
    expect(resolveImgSrc('./img/a.png', '/docs', null)).toBe('./img/a.png');
    expect(resolveImgSrc('/abs/a.png', '/docs', null)).toBe('/abs/a.png');
  });

  it('相对路径基于 basePath 归一后交给 resolver', () => {
    expect(resolveImgSrc('./img/a.png', '/docs', (p) => p)).toBe('/docs/img/a.png');
    expect(resolveImgSrc('../assets/a.png', '/docs/guide', (p) => p)).toBe('/docs/assets/a.png');
    expect(resolveImgSrc('a.png', '/docs/', (p) => p)).toBe('/docs/a.png');
  });

  it('绝对路径归一后交给 resolver', () => {
    expect(resolveImgSrc('/docs//img/./a.png', '/docs', (p) => p)).toBe('/docs/img/a.png');
  });

  it('resolver 决定最终 URL（宿主注入 rootId）', () => {
    expect(resolveImgSrc('./a.png', '/docs', resolver)).toBe(
      '/api/files/raw?rootId=r1&path=%2Fdocs%2Fa.png'
    );
  });
});

// 自动语言识别护栏：未标语言的大代码块不能再走 highlightAuto，否则 1 MiB 就是十秒量级的主线程停顿。
describe('MarkdownPreview 自动识别护栏', () => {
  const render = (source: string) =>
    renderToStaticMarkup(<MarkdownPreview source={source} basePath="/docs" />);

  it('小的未标语言代码块仍然自动识别', () => {
    const html = render('```\nconst a = 1;\n```\n');
    expect(html).toContain('hljs-');
  });

  it('显式语言的大代码块仍然高亮', () => {
    const html = render(`\`\`\`ts\n${'const a = 1;\n'.repeat(6000)}\`\`\`\n`);
    expect(html).toContain('hljs-keyword');
  });

  // 护栏前同一份输入要 ~9 s（全靠 highlightAuto），护栏后只剩 react-markdown 自身的解析开销（~140 ms）。
  it('1 MiB 未标语言代码块跳过识别，不再有秒级停顿', () => {
    const source = `\`\`\`\n${'lorem ipsum dolor sit amet 0123456789\n'.repeat(28000)}\`\`\`\n`;
    expect(source.length).toBeGreaterThan(1024 * 1024);
    const started = performance.now();
    const html = render(source);
    const elapsed = performance.now() - started;
    expect(html).toContain('no-highlight');
    expect(html).not.toContain('hljs-');
    // 跳过识别拿不到 language-* class，但它仍是 fenced 块，不能退化成 inline code 的药丸样式。
    expect(html).not.toContain('px-1.5 py-0.5');
    expect(elapsed).toBeLessThan(500);
  });

  it('阈值：块超 64 KiB 或整篇超 256 KiB 都跳过识别', () => {
    expect(skipsAutoDetect(1024, 1024)).toBe(false);
    expect(skipsAutoDetect(64 * 1024 + 1, 1024)).toBe(true);
    expect(skipsAutoDetect(1024, 256 * 1024 + 1)).toBe(true);
  });
});
