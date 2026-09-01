// 复选框的渲染结构：勾选态只体现在 data 属性上，未勾选时不挂 indicator。

import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { Checkbox } from './checkbox';

function rootTag(html: string): string {
  const at = html.indexOf('data-slot="checkbox"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('Checkbox', () => {
  test('未勾选：带 data-unchecked，不渲染 indicator', () => {
    const html = renderToStaticMarkup(<Checkbox checked={false} aria-label="选择" />);
    const tag = rootTag(html);
    expect(tag).toContain('data-unchecked');
    expect(tag).toContain('role="checkbox"');
    expect(tag).toContain('aria-label="选择"');
    expect(html).not.toContain('data-slot="checkbox-indicator"');
  });

  test('已勾选：带 data-checked 并渲染 indicator', () => {
    const html = renderToStaticMarkup(<Checkbox checked aria-label="选择" />);
    expect(rootTag(html)).toContain('data-checked');
    expect(html).toContain('data-slot="checkbox-indicator"');
  });

  test('禁用：带 data-disabled 与 aria-disabled', () => {
    const html = renderToStaticMarkup(<Checkbox checked={false} disabled aria-label="选择" />);
    const tag = rootTag(html);
    expect(tag).toContain('data-disabled');
    expect(tag).toContain('aria-disabled="true"');
  });

  test('半选：带 data-indeterminate 并渲染 indicator', () => {
    const html = renderToStaticMarkup(<Checkbox checked={false} indeterminate aria-label="选择" />);
    expect(rootTag(html)).toContain('data-indeterminate');
    expect(html).toContain('data-slot="checkbox-indicator"');
  });

  test('外部 className 追加而不是覆盖', () => {
    const html = renderToStaticMarkup(<Checkbox checked={false} className="ml-2" />);
    const tag = rootTag(html);
    expect(tag).toContain('ml-2');
    expect(tag).toContain('size-4');
  });
});
