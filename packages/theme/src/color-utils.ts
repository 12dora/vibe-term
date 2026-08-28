// WCAG 相对亮度/对比度：预设配色的可读性校验与代码高亮取色都要用（生成脚本 + 测试共享）。

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(
    value.trim()
  );
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]) };
  }
  throw new Error(`unsupported color: ${value}`);
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** sRGB 线性插值：t=0 取 a，t=1 取 b */
export function mixColors(a: string, b: string, t: number): string {
  const A = parseColor(a);
  const B = parseColor(b);
  return toHex({
    r: A.r + (B.r - A.r) * t,
    g: A.g + (B.g - A.g) * t,
    b: A.b + (B.b - A.b) * t,
  });
}

/**
 * 保持色相、朝黑/白方向逐档调整，直到对 background 的对比度达标。
 * 已达标则原样返回，故官方色值只在确实不可读时才被改动。
 */
export function ensureContrast(color: string, background: string, target: number): string {
  if (contrastRatio(color, background) >= target) return color;
  const toward = relativeLuminance(background) > 0.5 ? '#000000' : '#ffffff';
  for (let step = 1; step <= 50; step += 1) {
    const candidate = mixColors(color, toward, step / 50);
    if (contrastRatio(candidate, background) >= target) return candidate;
  }
  return toward;
}
