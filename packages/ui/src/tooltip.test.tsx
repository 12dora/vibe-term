import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Tooltip, applyTooltipEvent } from './tooltip';

describe('applyTooltipEvent', () => {
  test('悬停与聚焦打开，移出与失焦在未钉住时关闭', () => {
    expect(applyTooltipEvent({ open: false, sticky: false }, 'pointerenter')).toEqual({
      open: true,
      sticky: false,
    });
    expect(applyTooltipEvent({ open: true, sticky: false }, 'pointerleave')).toEqual({
      open: false,
      sticky: false,
    });
    expect(applyTooltipEvent({ open: false, sticky: false }, 'focus')).toEqual({
      open: true,
      sticky: false,
    });
    expect(applyTooltipEvent({ open: true, sticky: false }, 'blur')).toEqual({
      open: false,
      sticky: false,
    });
  });

  test('点击钉住，再点或 Escape 关闭；钉住期间移出不关', () => {
    const sticky = applyTooltipEvent({ open: true, sticky: false }, 'click');
    expect(sticky).toEqual({ open: true, sticky: true });
    expect(applyTooltipEvent(sticky, 'pointerleave')).toEqual(sticky);
    expect(applyTooltipEvent(sticky, 'blur')).toEqual(sticky);
    expect(applyTooltipEvent(sticky, 'click')).toEqual({ open: false, sticky: false });
    expect(applyTooltipEvent(sticky, 'escape')).toEqual({ open: false, sticky: false });
  });
});

describe('Tooltip', () => {
  test('默认关闭：触发器带 aria-describedby，内容 role=tooltip 且 hidden', () => {
    const html = renderToStaticMarkup(
      <Tooltip content={<span>说明</span>}>
        <button type="button">更多</button>
      </Tooltip>
    );
    expect(html).toContain('data-slot="tooltip"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('aria-describedby="');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('hidden');
    expect(html).toContain('说明');
    expect(html).toContain('更多');
  });

  test('defaultOpen：展开且不带 hidden', () => {
    const html = renderToStaticMarkup(
      <Tooltip defaultOpen content={<span data-testid="tip">内容</span>}>
        <button type="button">触发</button>
      </Tooltip>
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-testid="tip"');
    expect(html).not.toMatch(/role="tooltip"[^>]*hidden/);
  });

  test('受控 open 覆盖 defaultOpen', () => {
    const closed = renderToStaticMarkup(
      <Tooltip open={false} defaultOpen content="x">
        <button type="button">t</button>
      </Tooltip>
    );
    expect(closed).toContain('data-state="closed"');
    const opened = renderToStaticMarkup(
      <Tooltip open content="x">
        <button type="button">t</button>
      </Tooltip>
    );
    expect(opened).toContain('data-state="open"');
  });
});
