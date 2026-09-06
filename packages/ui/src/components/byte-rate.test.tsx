// ByteRate 的静态标记：等宽数字 + 不换行 + 可覆盖的最小宽度，缺一个列宽就会跟着数值抖。

import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ByteRate } from './byte-rate';

describe('<ByteRate />', () => {
  test('默认摆出等宽数字、不换行、右对齐的最小宽度', () => {
    const html = renderToStaticMarkup(<ByteRate>12.3 MB/s</ByteRate>);
    expect(html).toContain('data-slot="byte-rate"');
    expect(html).toContain('inline-block');
    expect(html).toContain('text-right');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('min-w-[7.5ch]');
    expect(html).toContain('>12.3 MB/s<');
  });

  test('最小宽度可覆盖，默认值不会一起留下', () => {
    const html = renderToStaticMarkup(<ByteRate minWidthClass="min-w-[18ch]">0.0 KB/s</ByteRate>);
    expect(html).toContain('min-w-[18ch]');
    expect(html).not.toContain('min-w-[7.5ch]');
  });

  test('className 里的最小宽度覆盖默认值（cn 合并同组类）', () => {
    const html = renderToStaticMarkup(<ByteRate className="min-w-[11ch]">0.0 KB/s</ByteRate>);
    expect(html).toContain('min-w-[11ch]');
    expect(html).not.toContain('min-w-[7.5ch]');
  });

  test('透传原生属性', () => {
    const html = renderToStaticMarkup(<ByteRate title="速率">1.0 KB/s</ByteRate>);
    expect(html).toContain('title="速率"');
  });
});
