// Base UI 的 Viewport 把 `overflow: scroll` 写死在内联样式里，class 覆盖不掉；
// `axis="vertical"` 必须以同一个简写属性内联覆盖，否则侧栏拖拽时会被横向溢出拽偏。

import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ScrollArea } from './scroll-area';

function viewportTag(html: string): string {
  const start = html.indexOf('data-slot="scroll-area-viewport"');
  expect(start).toBeGreaterThan(0);
  return html.slice(html.lastIndexOf('<', start), html.indexOf('>', start) + 1);
}

describe('ScrollArea 的滚动轴', () => {
  test('缺省两轴都可滚（沿用 Base UI 的 overflow: scroll）', () => {
    const tag = viewportTag(renderToStaticMarkup(<ScrollArea>内容</ScrollArea>));
    expect(tag).toContain('overflow:scroll');
    expect(tag).not.toContain('hidden scroll');
  });

  test('axis="vertical" 只留纵向滚动并断掉横向滚动链', () => {
    const tag = viewportTag(renderToStaticMarkup(<ScrollArea axis="vertical">内容</ScrollArea>));
    expect(tag).toContain('overflow:hidden scroll');
    expect(tag).toContain('overscroll-behavior-x:none');
  });
});
