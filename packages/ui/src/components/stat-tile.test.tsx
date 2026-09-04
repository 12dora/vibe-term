// StatTile 的静态标记：加载态换骨架、缺值出破折号、tone 只染数值、stale 只降透明度。

import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { StatTile } from './stat-tile';

describe('<StatTile />', () => {
  test('标签、数值、单位、副行各占一个槽位', () => {
    const html = renderToStaticMarkup(
      <StatTile label="吞吐" value="12.3" unit="MB/s" sub="↑ 8.1 · ↓ 4.2" />
    );
    expect(html).toContain('data-slot="stat-tile"');
    expect(html).toContain('>吞吐<');
    expect(html).toContain('data-slot="stat-tile-value"');
    expect(html).toContain('>12.3<');
    expect(html).toContain('>MB/s<');
    expect(html).toContain('↑ 8.1 · ↓ 4.2');
  });

  test('数值用等宽数字，刷新时不抖', () => {
    const html = renderToStaticMarkup(<StatTile label="延迟" value="42" />);
    expect(html).toContain('tabular-nums');
  });

  test('没有数值时出破折号而不是空白', () => {
    expect(renderToStaticMarkup(<StatTile label="延迟" />)).toContain('—');
  });

  test('加载态：数值与副行换成骨架，不渲染折线', () => {
    const html = renderToStaticMarkup(
      <StatTile label="吞吐" value="12" sub="x" loading sparkline={<i data-testid="spark" />} />
    );
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain('data-slot="stat-tile-value"');
    expect(html).not.toContain('data-slot="stat-tile-sparkline"');
  });

  test('折线槽位在非加载态渲染', () => {
    const html = renderToStaticMarkup(
      <StatTile label="吞吐" value="12" sparkline={<i data-testid="spark" />} />
    );
    expect(html).toContain('data-slot="stat-tile-sparkline"');
    expect(html).toContain('data-testid="spark"');
  });

  test('tone 落在 data 属性与数值配色上', () => {
    const html = renderToStaticMarkup(<StatTile label="延迟" value="900" tone="warning" />);
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('text-amber-600');
  });

  test('缺省 tone 是 default，数值不额外着色', () => {
    const html = renderToStaticMarkup(<StatTile label="延迟" value="9" />);
    expect(html).toContain('data-tone="default"');
    expect(html).toContain('text-foreground');
  });

  test('stale 只降透明度，数值照旧摆出来', () => {
    const html = renderToStaticMarkup(<StatTile label="延迟" value="9" stale />);
    expect(html).toContain('data-stale=""');
    expect(html).toContain('opacity-60');
    expect(html).toContain('>9<');
  });

  test('hint 落到 title 上', () => {
    expect(
      renderToStaticMarkup(<StatTile label="延迟" value="9" hint="成员 RTT 中位数" />)
    ).toContain('title="成员 RTT 中位数"');
  });

  test('外部 className 追加而不是覆盖', () => {
    const html = renderToStaticMarkup(<StatTile label="延迟" value="9" className="col-span-2" />);
    expect(html).toContain('col-span-2');
    expect(html).toContain('bg-card');
    expect(html).toContain('data-size="sm"');
  });
});
