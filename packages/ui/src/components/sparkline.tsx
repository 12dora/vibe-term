// 内联 SVG 迷你折线：只负责把一串数值画成一条线，不做坐标轴、图例与交互。
//
// 纵轴一律从 0 起（速率/延迟都是非负量，零基线才不会把噪声放大成尖峰），整段为 0 或序列为空时
// 落在底边并改画一条虚线基线。空序列与 NaN 都不会让它崩——除以零的分支在 `sparklineScale` 收敛。

import type * as React from 'react';

import { cn } from '../utils';

export type SparklineTone = 'default' | 'accent' | 'success' | 'warning' | 'destructive' | 'muted';

const TONE_CLASS: Record<SparklineTone, string> = {
  default: 'text-[color:var(--chart-1,var(--primary))]',
  accent: 'text-sky-500',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

export const SPARKLINE_DEFAULT_WIDTH = 96;
export const SPARKLINE_DEFAULT_HEIGHT = 28;

/** 描边不被裁掉所需的上下留白。 */
const EDGE_PAD = 2;

/** 描一条线所需的最小信息；多条线叠在同一坐标系里（共用纵轴）。 */
export interface SparklineSeries {
  values: number[];
  tone?: SparklineTone;
  /** 线下填充一层低透明度色块。 */
  fill?: boolean;
}

export interface SparklineScale {
  min: number;
  max: number;
}

/** 非有限值按 0 计，保持下标与时间轴对齐（丢点会让整条线横向漂移）。 */
export function sanitizeSparklineValues(values: readonly number[]): number[] {
  return values.map((value) => (Number.isFinite(value) ? value : 0));
}

/**
 * 纵轴范围：下界取 0 与最小值的较小者，上界取最大值（`max` 可抬高上界，用于多图对齐刻度）。
 * 上下界相等（空序列 / 全零 / 全负截断）时给一个宽度为 1 的窗口，绘制时落在底边。
 */
export function sparklineScale(values: readonly number[], max?: number): SparklineScale {
  const finite = sanitizeSparklineValues(values.filter((value) => Number.isFinite(value)));
  const lo = finite.length === 0 ? 0 : Math.min(0, ...finite);
  const dataHi = finite.length === 0 ? 0 : Math.max(...finite);
  const hi = max !== undefined && Number.isFinite(max) ? Math.max(dataHi, max) : dataHi;
  return hi > lo ? { min: lo, max: hi } : { min: lo, max: lo + 1 };
}

export interface SparklinePoint {
  x: number;
  y: number;
}

/**
 * 把序列映射到 `width × height` 的画布。单点序列画成一条横线（左右各一个点）。
 */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  scale: SparklineScale
): SparklinePoint[] {
  const clean = sanitizeSparklineValues(values);
  if (clean.length === 0) return [];
  const span = Math.max(scale.max - scale.min, Number.EPSILON);
  const usable = Math.max(height - EDGE_PAD * 2, 1);
  const toY = (value: number) => {
    const ratio = Math.min(1, Math.max(0, (value - scale.min) / span));
    return EDGE_PAD + (1 - ratio) * usable;
  };
  if (clean.length === 1) {
    const y = toY(clean[0]);
    return [
      { x: 0, y },
      { x: width, y },
    ];
  }
  const step = width / (clean.length - 1);
  return clean.map((value, index) => ({ x: index * step, y: toY(value) }));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function sparklineLinePath(points: readonly SparklinePoint[]): string {
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)},${round(point.y)}`)
    .join(' ');
}

export function sparklineAreaPath(points: readonly SparklinePoint[], height: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${sparklineLinePath(points)} L${round(last.x)},${height} L${round(first.x)},${height} Z`;
}

export interface SparklineProps
  extends Omit<React.ComponentProps<'svg'>, 'values' | 'fill' | 'max' | 'role'> {
  /** 单条线的取值；与 `series` 二选一。 */
  values?: number[];
  /** 多条线叠画，共用一套坐标系。 */
  series?: SparklineSeries[];
  width?: number;
  height?: number;
  tone?: SparklineTone;
  fill?: boolean;
  /** 纵轴上限的下限：多张图要对齐刻度时传同一个值。 */
  max?: number;
  /** 给出即以 `role="img"` 暴露给读屏；否则整块对无障碍树隐藏。 */
  ariaLabel?: string;
}

interface DrawnSeries {
  id: string;
  tone: SparklineTone;
  fill: boolean;
  points: SparklinePoint[];
}

interface DrawOptions {
  width: number;
  height: number;
  tone: SparklineTone;
  fill: boolean;
  max?: number;
}

function drawSeries(lines: SparklineSeries[], options: DrawOptions): DrawnSeries[] {
  const scale = sparklineScale(
    lines.flatMap((line) => line.values),
    options.max
  );
  return lines.map((line, index) => ({
    id: `${index}-${line.tone ?? options.tone}`,
    tone: line.tone ?? options.tone,
    fill: line.fill ?? options.fill,
    points: sparklinePoints(line.values, options.width, options.height, scale),
  }));
}

export function Sparkline({
  values,
  series,
  width = SPARKLINE_DEFAULT_WIDTH,
  height = SPARKLINE_DEFAULT_HEIGHT,
  tone = 'default',
  fill = false,
  max,
  ariaLabel,
  className,
  ...props
}: SparklineProps) {
  const lines: SparklineSeries[] = series ?? [{ values: values ?? [] }];
  const drawn = drawSeries(lines, { width, height, tone, fill, max });
  const empty = drawn.every((line) => line.points.length === 0);

  return (
    <svg
      data-slot="sparkline"
      data-empty={empty ? '' : undefined}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn('block overflow-visible', className)}
      {...props}
    >
      {empty ? (
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          className="text-border"
          stroke="currentColor"
          strokeDasharray="2 3"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        drawn.map((line) => (
          <g key={line.id} className={TONE_CLASS[line.tone]}>
            {line.fill && (
              <path
                d={sparklineAreaPath(line.points, height)}
                fill="currentColor"
                fillOpacity={0.12}
                stroke="none"
              />
            )}
            <path
              d={sparklineLinePath(line.points)}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))
      )}
    </svg>
  );
}
