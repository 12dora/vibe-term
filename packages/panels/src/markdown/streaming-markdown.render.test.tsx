// 未封口围栏短路：流式追加时尾块不再每 40 ms 全量喂给 react-markdown。
// 用 mock 包住 react-markdown（转发真实实现）计调用次数与累计 parse 字符数，
// 断言「每次 flush 的成本随 delta 而非尾块长度增长」。

import { describe, expect, mock, test } from 'bun:test';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const realMarkdown = (await import('react-markdown')) as unknown as Record<string, unknown>;
const RealReactMarkdown = realMarkdown.default as ComponentType<{ children?: string }>;

const parse = { calls: 0, chars: 0 };

mock.module('react-markdown', () => ({
  ...realMarkdown,
  default: (props: { children?: string }) => {
    parse.calls += 1;
    parse.chars += props.children?.length ?? 0;
    return <RealReactMarkdown {...props} />;
  },
}));

const { StreamingMarkdown, openFenceTail } = await import('./streaming-markdown');

function reset(): void {
  parse.calls = 0;
  parse.chars = 0;
}

function render(text: string): string {
  return renderToStaticMarkup(<StreamingMarkdown text={text} />);
}

describe('openFenceTail', () => {
  test('未封口围栏返回语言与栏内原文', () => {
    expect(openFenceTail('```ts\nconst a = 1;\n')).toEqual({ lang: 'ts', body: 'const a = 1;\n' });
    expect(openFenceTail('```\nplain')).toEqual({ lang: '', body: 'plain\n' });
  });

  test('info string 只取第一个词', () => {
    expect(openFenceTail('```ts title=a.ts\nx')?.lang).toBe('ts');
  });

  test('封口后交回完整 parse', () => {
    expect(openFenceTail('```ts\nconst a = 1;\n```')).toBeNull();
    expect(openFenceTail('```ts\nx\n```   ')).toBeNull();
    expect(openFenceTail('```ts\nx\n``````')).toBeNull();
  });

  test('更短或异种的内层围栏不算封口', () => {
    expect(openFenceTail('````md\n```ts\nx\n```\n')).toEqual({
      lang: 'md',
      body: '```ts\nx\n```\n',
    });
    expect(openFenceTail('````md\n```ts\nx\n```\n````')).toBeNull();
    expect(openFenceTail('~~~\n```\nx\n```\n')?.body).toBe('```\nx\n```\n');
  });

  test('波浪线围栏按同一套规则封口', () => {
    expect(openFenceTail('~~~py\nx = 1\n')).toEqual({ lang: 'py', body: 'x = 1\n' });
    expect(openFenceTail('~~~py\nx = 1\n~~~')).toBeNull();
    expect(openFenceTail('~~~~py\nx\n~~~\n')?.body).toBe('x\n~~~\n');
  });

  test('反引号围栏的 info string 含反引号即不成栏', () => {
    expect(openFenceTail('```a`b\nx')).toBeNull();
  });

  test('缩进 0-3 成栏并按缩进量剥离，4 空格是缩进代码块', () => {
    expect(openFenceTail('   ```ts\n   x\n     y\n')).toEqual({ lang: 'ts', body: 'x\n  y\n' });
    expect(openFenceTail('    ```ts\nx')).toBeNull();
  });

  test('围栏不在块首（列表项内）不短路', () => {
    expect(openFenceTail('- item\n  ```ts\n  code')).toBeNull();
    expect(openFenceTail('文字\n```ts\ncode')).toBeNull();
  });

  test('CRLF 文本的封口行（结尾带 \\r）同样算封口', () => {
    expect(openFenceTail('```ts\r\nconst a = 1;\r\n```\r\n')).toBeNull();
    expect(openFenceTail('```ts\r\nx\r\n```   \r')).toBeNull();
    expect(openFenceTail('~~~py\r\nx = 1\r\n~~~\r')).toBeNull();
    // 未封口时仍按未封口处理，语言不带 \r
    expect(openFenceTail('```ts\r\nconst a = 1;\r\n')?.lang).toBe('ts');
  });

  test('只有围栏首行时栏内为空', () => {
    expect(openFenceTail('```ts')).toEqual({ lang: 'ts', body: '' });
    expect(openFenceTail('```ts\n')).toEqual({ lang: 'ts', body: '' });
  });
});

describe('StreamingMarkdown 未封口围栏', () => {
  test('未封口与封口产出同一套 pre/code 结构，封口不跳版', () => {
    reset();
    const open = render('```ts\nconst a = 1;\n');
    const openCalls = parse.calls;
    const sealed = render('```ts\nconst a = 1;\n```');
    expect(open).toBe(sealed);
    expect(openCalls).toBe(0);
    expect(parse.calls).toBe(1);
  });

  test('无语言的未封口围栏也不带 language- class', () => {
    reset();
    expect(render('```\nplain\n')).toBe(render('```\nplain\n```'));
  });

  test('封口后交回 react-markdown，列表项内的围栏始终走完整 parse', () => {
    reset();
    const html = render('- item\n  ```ts\n  code');
    expect(parse.calls).toBe(1);
    expect(html).toContain('<li>');
  });

  test('每次 flush 的 parse 成本随 delta 而非尾块长度增长', () => {
    const head = '前言\n\n';
    const chunk = 'const value = 1;\n';
    reset();
    let text = `${head}\`\`\`ts\n`;
    for (let i = 0; i < 200; i += 1) {
      text += chunk;
      render(text);
    }
    // 尾块 200 次 flush 累计 ~3.4 KB；只有开头那个已封口块被 parse，每次 flush 一遍
    expect(parse.calls).toBe(200);
    expect(parse.chars).toBe(200 * head.trim().length);
    expect(text.length).toBeGreaterThan(3000);

    // 对照：同样的追加节奏，尾块不是围栏时每次 flush 都要重 parse 整个尾块
    reset();
    let plain = head;
    for (let i = 0; i < 200; i += 1) {
      plain += chunk;
      render(plain);
    }
    expect(parse.chars).toBeGreaterThan(100 * 1000);
  });
});
