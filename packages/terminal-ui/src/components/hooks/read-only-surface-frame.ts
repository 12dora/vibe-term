// 录像回放的「屏幕」外观：平移视口里只有内容表面（.xterm-screen）保留终端底色，
// 视口外一圈换成更暗的衬底（letterbox），内容表面再描一圈边，看得出录制画面到哪为止。
// 内容表面比外框小时用 margin:auto 居中——溢出（自动边距归零）时仍贴左上，平移到原点不受影响，
// 命中测试走 .xterm-screen 的 getBoundingClientRect，居中位移自然被算进去。

import type { TerminalThemeColors } from '@vibeterm/shared';
import { contrastRatio, mixColors, relativeLuminance } from '@vibeterm/theme/color-utils';

const VIEWPORT_SELECTOR = '.xterm-viewport';
const SCREEN_SELECTOR = '.xterm-screen';

/** 衬底与终端底色至少要拉开这么多对比度，否则 letterbox 与录制画面同色，等于没有。 */
export const MIN_BACKDROP_CONTRAST = 1.2;
const DARK_LUMINANCE = 0.35;
const DARK_BACKDROP_MIX = 0.45;
const LIGHT_BACKDROP_MIX = 0.16;
const OPPOSITE_BACKDROP_MIX = 0.1;
const BACKDROP_MIX_STEP = 0.05;
const OUTLINE_MIX = 0.55;
const FALLBACK_BACKDROP = 'rgba(0, 0, 0, 0.35)';
const FALLBACK_OUTLINE = 'rgba(128, 128, 128, 0.7)';

/** 朝 `toward` 逐档加量，直到与底色拉开 `MIN_BACKDROP_CONTRAST`。 */
function mixUntilContrast(background: string, toward: string, start: number): string {
  let mix = start;
  let candidate = mixColors(background, toward, mix);
  while (mix < 1 && contrastRatio(background, candidate) < MIN_BACKDROP_CONTRAST) {
    mix = Math.min(1, mix + BACKDROP_MIX_STEP);
    candidate = mixColors(background, toward, mix);
  }
  return candidate;
}

/**
 * 衬底色：先按底色明暗朝黑里压，压不出可分差就掉头（近黑朝白提，其余继续压）。
 *
 * 不能只按绝对亮度分档：那样在近黑处是断崖——`#0d1117`（GitHub Dark）这类底色压完与画面同色，
 * 整块 letterbox 白做。改成算完再校验对比度，保证任何预设都看得出内外之分。
 */
export function readOnlySurfaceBackdrop(theme: TerminalThemeColors): string {
  try {
    const background = theme.background;
    const dark = relativeLuminance(background) < DARK_LUMINANCE;
    const ratio = dark ? DARK_BACKDROP_MIX : LIGHT_BACKDROP_MIX;
    const darkened = mixColors(background, '#000000', ratio);
    if (contrastRatio(background, darkened) >= MIN_BACKDROP_CONTRAST) return darkened;
    return mixUntilContrast(background, dark ? '#ffffff' : '#000000', OPPOSITE_BACKDROP_MIX);
  } catch {
    return FALLBACK_BACKDROP;
  }
}

/** 描边色：前景往底色里混，muted 一档，不抢内容。 */
export function readOnlySurfaceOutline(theme: TerminalThemeColors): string {
  try {
    return mixColors(theme.foreground, theme.background, OUTLINE_MIX);
  } catch {
    return FALLBACK_OUTLINE;
  }
}

function queryStyled(root: HTMLElement, selector: string): HTMLElement | null {
  return root.querySelector(selector) as HTMLElement | null;
}

function clearSurfaceFrame(
  root: HTMLElement,
  viewport: HTMLElement | null,
  screen: HTMLElement | null,
  theme: TerminalThemeColors
): void {
  root.style.backgroundColor = theme.background;
  if (viewport) {
    viewport.style.display = '';
    viewport.style.backgroundColor = '';
  }
  if (!screen) return;
  screen.style.backgroundColor = theme.background;
  screen.style.margin = '';
  screen.style.flex = '';
  screen.style.outline = '';
}

/**
 * 把外框样式写到 ghostty 的元素树上。ghostty 的 applyTheme 会把 root/screen 的底色重写成
 * 终端底色，所以本函数必须在每次下发主题之后再跑一遍。
 */
export function applyReadOnlySurfaceFrame(
  root: HTMLElement | null,
  theme: TerminalThemeColors,
  enabled: boolean
): void {
  if (!root) return;
  const viewport = queryStyled(root, VIEWPORT_SELECTOR);
  const screen = queryStyled(root, SCREEN_SELECTOR);
  if (!enabled) {
    clearSurfaceFrame(root, viewport, screen, theme);
    return;
  }

  root.style.backgroundColor = readOnlySurfaceBackdrop(theme);
  if (viewport) {
    viewport.style.display = 'flex';
    viewport.style.backgroundColor = 'transparent';
  }
  if (!screen) return;
  screen.style.backgroundColor = theme.background;
  screen.style.margin = 'auto';
  // flex 容器默认会压缩子项：内容表面的 px 尺寸即录像网格，不能被压。
  screen.style.flex = 'none';
  // 用 outline 不用 border：不进盒模型，命中测试的 rect 与画布原点仍严格对齐。
  screen.style.outline = `1px solid ${readOnlySurfaceOutline(theme)}`;
}
