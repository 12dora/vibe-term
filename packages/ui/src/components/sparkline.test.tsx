// Sparkline 的几何计算（纯函数）与静态标记：空序列 / NaN / 常量段都不能出除零或 NaN 坐标。

import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  Sparkline,
  sanitizeSparklineValues,
  sparklineAreaPath,
  sparklineLinePath,
  sparklinePoints,
  sparklineScale,
} from './sparkline';

describe('sanitizeSparklineValues', () => {
  test('非有限值按 0 计，长度不变', () => {
    expect(sanitizeSparklineValues([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toEqual([
      1, 0, 3, 0,
    ]);
  });
});

describe('sparklineScale', () => {
  test('零基线：非负序列的下界是 0', () => {
    expect(sparklineScale([2, 8, 5])).toEqual({ min: 0, max: 8 });
  });

  test('空序列与全零：给宽度为 1 的窗口，不会除以零', () => {
    expect(sparklineScale([])).toEqual({ min: 0, max: 1 });
    expect(sparklineScale([0, 0, 0])).toEqual({ min: 0, max: 1 });
  });

  test('负值把下界压下去', () => {
    expect(sparklineScale([-4, 2])).toEqual({ min: -4, max: 2 });
  });

  test('外部上限只抬高不压低', () => {
    expect(sparklineScale([2, 4], 10)).toEqual({ min: 0, max: 10 });
    expect(sparklineScale([2, 40], 10)).toEqual({ min: 0, max: 40 });
  });

  test('NaN 不会污染上下界', () => {
    expect(sparklineScale([Number.NaN, 5])).toEqual({ min: 0, max: 5 });
  });
});

describe('sparklinePoints', () => {
  const scale = sparklineScale([0, 10]);

  test('空序列没有点', () => {
    expect(sparklinePoints([], 100, 20, scale)).toEqual([]);
  });

  test('单点画成一条横线，左右各一个端点', () => {
    const points = sparklinePoints([5], 100, 20, scale);
    expect(points).toHaveLength(2);
    expect(points[0].x).toBe(0);
    expect(points[1].x).toBe(100);
    expect(points[0].y).toBe(points[1].y);
  });

  test('横坐标均分整幅宽度', () => {
    const points = sparklinePoints([0, 5, 10], 100, 20, scale);
    expect(points.map((p) => p.x)).toEqual([0, 50, 100]);
  });

  test('数值越大纵坐标越靠上，且全部落在画布内', () => {
    const points = sparklinePoints([0, 5, 10], 100, 20, scale);
    expect(points[2].y).toBeLessThan(points[1].y);
    expect(points[1].y).toBeLessThan(points[0].y);
    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(20);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  test('整段常量：所有点同高且是有限值', () => {
    const flat = sparklineScale([3, 3, 3]);
    const points = sparklinePoints([3, 3, 3], 100, 20, flat);
    expect(new Set(points.map((p) => p.y)).size).toBe(1);
    expect(Number.isFinite(points[0].y)).toBe(true);
  });

  test('全零序列落在底边', () => {
    const zero = sparklineScale([0, 0]);
    const points = sparklinePoints([0, 0], 100, 20, zero);
    expect(points[0].y).toBe(18);
  });

  test('NaN 当 0 处理，不产生 NaN 坐标', () => {
    const points = sparklinePoints([Number.NaN, 10], 100, 20, scale);
    expect(points.every((p) => Number.isFinite(p.y))).toBe(true);
  });
});

describe('sparklineLinePath / sparklineAreaPath', () => {
  test('空点集返回空串', () => {
    expect(sparklineLinePath([])).toBe('');
    expect(sparklineAreaPath([], 20)).toBe('');
  });

  test('折线以 M 起头，其余是 L', () => {
    const d = sparklineLinePath([
      { x: 0, y: 10 },
      { x: 50, y: 4 },
    ]);
    expect(d).toBe('M0,10 L50,4');
  });

  test('面积路径回到底边并闭合', () => {
    const d = sparklineAreaPath(
      [
        { x: 0, y: 10 },
        { x: 50, y: 4 },
      ],
      20
    );
    expect(d).toBe('M0,10 L50,4 L50,20 L0,20 Z');
  });

  test('坐标保留两位小数', () => {
    expect(sparklineLinePath([{ x: 1 / 3, y: 2 / 3 }])).toBe('M0.33,0.67');
  });
});

describe('<Sparkline />', () => {
  test('画出一条折线，尺寸与 viewBox 一致', () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 4, 2]} width={120} height={30} />);
    expect(html).toContain('data-slot="sparkline"');
    expect(html).toContain('viewBox="0 0 120 30"');
    expect(html).toContain('width="120"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toContain('data-empty');
  });

  test('空序列：出虚线基线并打 data-empty', () => {
    const html = renderToStaticMarkup(<Sparkline values={[]} />);
    expect(html).toContain('data-empty=""');
    expect(html).toContain('stroke-dasharray="2 3"');
    expect(html).not.toContain('<path');
  });

  test('填充开关控制面积路径', () => {
    expect(renderToStaticMarkup(<Sparkline values={[1, 2]} />)).not.toContain('fill-opacity');
    expect(renderToStaticMarkup(<Sparkline values={[1, 2]} fill />)).toContain(
      'fill-opacity="0.12"'
    );
  });

  test('tone 映射到色彩类', () => {
    expect(renderToStaticMarkup(<Sparkline values={[1, 2]} tone="success" />)).toContain(
      'text-emerald-500'
    );
    expect(renderToStaticMarkup(<Sparkline values={[1, 2]} tone="destructive" />)).toContain(
      'text-destructive'
    );
  });

  test('多条线共用一套刻度，各自一个分组', () => {
    const html = renderToStaticMarkup(
      <Sparkline
        series={[
          { values: [0, 100], tone: 'success' },
          { values: [0, 50], tone: 'accent' },
        ]}
        width={100}
        height={20}
      />
    );
    expect(html).toContain('text-emerald-500');
    expect(html).toContain('text-sky-500');
    // 第二条线的峰值是共同上限的一半，落在画布中段而不是顶边。
    expect(html).toContain('L100,10');
  });

  test('给了 ariaLabel 才进无障碍树', () => {
    const labeled = renderToStaticMarkup(<Sparkline values={[1, 2]} ariaLabel="吞吐" />);
    expect(labeled).toContain('role="img"');
    expect(labeled).toContain('aria-label="吞吐"');
    expect(renderToStaticMarkup(<Sparkline values={[1, 2]} />)).toContain('aria-hidden="true"');
  });

  test('外部 className 追加而不是覆盖', () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 2]} className="w-full" />);
    expect(html).toContain('w-full');
    expect(html).toContain('block');
  });
});
