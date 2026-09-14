import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Tooltip, applyTooltipEvent, placeTooltipPanel } from './tooltip';

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

  test('面板是 span 而不是 div，避免嵌在 span 根里', () => {
    const html = renderToStaticMarkup(
      <Tooltip defaultOpen content="x">
        <button type="button">t</button>
      </Tooltip>
    );
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain('<div');
  });
});

describe('placeTooltipPanel', () => {
  const viewport = { width: 400, height: 400 };

  test('首选下方：水平居中', () => {
    const placed = placeTooltipPanel({
      trigger: { top: 40, bottom: 60, left: 180, right: 220, width: 40, height: 20 },
      panel: { width: 200, height: 80 },
      preferred: 'bottom',
      viewport,
      gap: 4,
      margin: 8,
    });
    expect(placed.side).toBe('bottom');
    expect(placed.top).toBe(64);
    expect(placed.left).toBe(100);
  });

  test('下方放不下则翻到上方', () => {
    const placed = placeTooltipPanel({
      trigger: { top: 340, bottom: 360, left: 180, right: 220, width: 40, height: 20 },
      panel: { width: 120, height: 80 },
      preferred: 'bottom',
      viewport,
      gap: 4,
      margin: 8,
    });
    expect(placed.side).toBe('top');
    expect(placed.top).toBe(256);
  });

  test('水平方向夹进视口，边距 8px', () => {
    const left = placeTooltipPanel({
      trigger: { top: 40, bottom: 60, left: 0, right: 20, width: 20, height: 20 },
      panel: { width: 200, height: 40 },
      preferred: 'bottom',
      viewport,
      margin: 8,
    });
    expect(left.left).toBe(8);
    const right = placeTooltipPanel({
      trigger: { top: 40, bottom: 60, left: 380, right: 400, width: 20, height: 20 },
      panel: { width: 200, height: 40 },
      preferred: 'bottom',
      viewport,
      margin: 8,
    });
    expect(right.left).toBe(192);
  });
});
