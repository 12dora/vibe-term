import { isBlockElement } from './canvas-block-elements';
import { colorToCss } from './canvas-renderer-metrics';
import type {
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderSnapshotMeta,
} from './types';

// faint 组合键空间近 48 bit，truecolor 动画可无界撑大缓存；越界整表丢弃重建。
const FAINT_CACHE_LIMIT = 8192;

type SnapshotColors = GhosttyRenderSnapshotMeta['colors'];

// SGR 2（faint / dim）：前景色按 50% 朝该 cell 的实际背景色混合，与 ghostty / xterm 的
// half-bright 一致。混合而不是降 alpha，是为了让 run 批绘仍能按「已解析出的颜色」聚合。
const FAINT_MIX = 0.5;

const COLOR_KEY_SPAN = 0x1000000;

export function colorKey(color: GhosttyColorRgb): number {
  return (color.r << 16) | (color.g << 8) | color.b;
}

export function fontVariantIndex(style: GhosttyRenderCellStyle): number {
  return (style.italic ? 1 : 0) | (style.bold ? 2 : 0);
}

export function isSpacerCell(cell: GhosttyRenderCell): boolean {
  return cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head';
}

export function hasVisibleGlyph(cell: GhosttyRenderCell): boolean {
  return !isSpacerCell(cell) && cell.text !== '' && !cell.style.invisible;
}

export function hasDecorations(style: GhosttyRenderCellStyle): boolean {
  return style.underline > 0 || style.strikethrough || style.overline;
}

// inverse 时前后景互换；缺省色回落到快照的默认前/背景。返回的都是已有实例，不分配。
export function cellForegroundColor(
  cell: GhosttyRenderCell,
  colors: SnapshotColors
): GhosttyColorRgb {
  if (cell.style.inverse) {
    return cell.bgColor ?? colors.background;
  }

  return cell.fgColor ?? colors.foreground;
}

export function cellBackgroundColor(
  cell: GhosttyRenderCell,
  colors: SnapshotColors
): GhosttyColorRgb {
  if (cell.style.inverse) {
    return cell.fgColor ?? colors.foreground;
  }

  return cell.bgColor ?? colors.background;
}

export function blendFaint(fg: GhosttyColorRgb, bg: GhosttyColorRgb): GhosttyColorRgb {
  return {
    r: Math.round(fg.r + (bg.r - fg.r) * FAINT_MIX),
    g: Math.round(fg.g + (bg.g - fg.g) * FAINT_MIX),
    b: Math.round(fg.b + (bg.b - fg.b) * FAINT_MIX),
  };
}

// 只有「单码位且落在块元素区」的 cell 才自绘，其余交给字体。
export function blockElementCodepoint(cell: GhosttyRenderCell): number {
  if (cell.codepoints.length !== 1) {
    return -1;
  }

  const codepoint = cell.codepoints[0];
  return isBlockElement(codepoint) ? codepoint : -1;
}

/**
 * 颜色 / 字体串的解析与缓存。渲染器每帧对每个 cell 都要问一次前景色 CSS 与字体串，
 * 这里把 rgb→css、faint 混合、字形变体三张表都缓存住，热路径上零分配。
 */
export class CellStyleResolver {
  private readonly colorCache = new Map<number, string>();
  private readonly faintCache = new Map<number, string>();
  private fontVariants: (string | null)[] = [null, null, null, null];
  private deviceFontSize = 13;

  constructor(private readonly fontFamily: string) {}

  /** 主题变化：颜色表整体失效（faint 混合依赖默认前/背景色，一并清）。 */
  clearColors(): void {
    this.colorCache.clear();
    this.faintCache.clear();
  }

  /** 字号 / dpr 变化：四种字形变体串失效。 */
  resetFonts(deviceFontSize: number): void {
    this.deviceFontSize = deviceFontSize;
    this.fontVariants = [null, null, null, null];
  }

  dispose(): void {
    this.clearColors();
    this.fontVariants = [null, null, null, null];
  }

  toCss(color: GhosttyColorRgb): string {
    const key = colorKey(color);
    const cached = this.colorCache.get(key);
    if (cached) {
      return cached;
    }

    const css = colorToCss(color);
    this.colorCache.set(key, css);
    return css;
  }

  /** 前景色 CSS：inverse 已在 cellForegroundColor 里换过手，这里只额外处理 faint。 */
  foregroundCss(cell: GhosttyRenderCell, colors: SnapshotColors): string {
    const fg = cellForegroundColor(cell, colors);
    if (!cell.style.faint) {
      return this.toCss(fg);
    }

    const bg = cellBackgroundColor(cell, colors);
    const key = colorKey(fg) * COLOR_KEY_SPAN + colorKey(bg);
    const cached = this.faintCache.get(key);
    if (cached) {
      return cached;
    }

    const css = colorToCss(blendFaint(fg, bg));
    if (this.faintCache.size >= FAINT_CACHE_LIMIT) {
      this.faintCache.clear();
    }
    this.faintCache.set(key, css);
    return css;
  }

  resolveFont(style: GhosttyRenderCellStyle): string {
    return this.fontAt(fontVariantIndex(style));
  }

  /** 无 bold / italic 的基准字体串，供度量字形盒使用。 */
  regularFont(): string {
    return this.fontAt(0);
  }

  private fontAt(index: number): string {
    const cached = this.fontVariants[index];
    if (cached !== null) {
      return cached;
    }

    const italic = (index & 1) !== 0;
    const bold = (index & 2) !== 0;
    const font = `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${this.deviceFontSize}px ${this.fontFamily}`;
    this.fontVariants[index] = font;
    return font;
  }
}
