// 终端/等宽字体的运行时接线：选字体 → 派生 CSS 字体栈 + 懒加载 woff2。
// 字号/行高仅作用于终端；字体族经 --font-mono 全应用统一（见 useAppMonoFont）。
//
// 加载分两段（见 FontSubsetFiles）：
//   第一段 = 精确测宽所需的字形。默认字体是 latin 子集（约 45 KB），其余字体是整份。
//   第二段 = Nerd 图标等余下字形 + 符号兜底字体（162 KB），font-display:swap 后到。
// 终端首帧只等第一段：默认字体两个字重原本合计 2.3 MB，2 Mbps 下就是 9 秒纯等待。

import { DEFAULT_FONT_ID, FONT_MANIFEST } from './manifest.generated';
import type { FontManifestEntry, FontSubsetFiles } from './types';
import { sampleTextForRange } from './unicode-range';

export { DEFAULT_FONT_ID, FONT_MANIFEST };
export type { FontManifestEntry, FontSubsetFiles };
export { firstCodepointOfRange, sampleTextForRange } from './unicode-range';

// 符号兜底字体（媒体控制/Braille/勾选等），恒定挂在主字体之后，CJK 落系统 monospace。
const SYMBOL_FALLBACK = 'NotoSansSymbols2VibeTerm';

/** 第一段的样本文本：拉丁字母 + 数字 + 框线 + 块元素，全部落在子集 unicode-range 内 */
export const FIRST_PAINT_SAMPLE_TEXT = 'Aa0 │█';

export function getFontEntry(fontId: string): FontManifestEntry {
  return (
    FONT_MANIFEST.find((f) => f.id === fontId) ??
    FONT_MANIFEST.find((f) => f.id === DEFAULT_FONT_ID) ??
    (FONT_MANIFEST[0] as FontManifestEntry)
  );
}

/** 由 fontId 派生完整 CSS font-family 栈：主字体 → 符号兜底 → 系统等宽。 */
export function resolveFontStack(fontId: string): string {
  return `${getFontEntry(fontId).cssFamily}, ${SYMBOL_FALLBACK}, monospace`;
}

const injectedFamilies = new Set<string>();

// 非默认字体在选中时才注入 @font-face（默认 Geist 的四条面已在 index.css 静态声明）。
function injectFontFace(entry: FontManifestEntry): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || !entry.files || injectedFamilies.has(entry.cssFamily)) {
    return;
  }
  const style = doc.createElement('style');
  style.dataset.vibetermFont = entry.id;
  style.textContent =
    `@font-face{font-family:${entry.cssFamily};` +
    `src:url("${entry.files.regular}") format("woff2");font-weight:400;font-style:normal;font-display:swap}` +
    `@font-face{font-family:${entry.cssFamily};` +
    `src:url("${entry.files.bold}") format("woff2");font-weight:700;font-style:normal;font-display:swap}`;
  doc.head.appendChild(style);
  injectedFamilies.add(entry.cssFamily);
}

/**
 * 只注入 @font-face、不触发下载：让 --font-mono 的 family 立刻可解析，woff2 由浏览器
 * 在真正有文字用到该字体时才拉（font-display:swap 负责替换）。应用外壳走这条路径，
 * 真正需要字形度量的终端才调 loadTerminalFonts 强制加载。默认字体已静态声明，空操作。
 */
export function ensureFontFaceInjected(fontId: string): void {
  const entry = getFontEntry(fontId);
  if (!entry.isDefault) {
    injectFontFace(entry);
  }
}

function documentFonts(): FontFaceSet | undefined {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSet } }).document?.fonts;
  return typeof fonts?.load === 'function' ? fonts : undefined;
}

function loadFamily(
  fonts: FontFaceSet,
  family: string,
  fontSize: number,
  text: string
): Promise<unknown>[] {
  return [
    fonts.load(`${fontSize}px ${family}`, text),
    fonts.load(`bold ${fontSize}px ${family}`, text),
  ];
}

export interface TerminalFontStages {
  /** 首屏必需的字形：resolve 后 canvas 测宽即为最终值 */
  ready: Promise<void>;
  /**
   * 启动二段加载（Nerd 图标 + 符号兜底，合计仍有 2.5 MB）并返回其完成信号；
   * null 表示本次无二段。刻意做成「按需启动」而不是一并发起：
   * 首帧还没出来就开拉，它们会跟子集和 wasm 抢同一条 2 Mbps 的管子。
   */
  startUpgrade: (() => Promise<void>) | null;
}

const NO_STAGES: TerminalFontStages = { ready: Promise.resolve(), startUpgrade: null };

const settled = (tasks: readonly Promise<unknown>[]): Promise<void> =>
  // 字体加载失败静默降级到 monospace / 系统兜底，不阻塞渲染也不炸二段重绘
  Promise.all(tasks).then(
    () => undefined,
    () => undefined
  );

/**
 * 两段加载。第一段必须 await（终端据此测宽），第二段交给调用方：
 * 它只影响 Nerd 图标 / 符号字形，到达后重绘一次即可，绝不能挡首帧。
 * 幂等性由 terminal-ui 的 terminal-fonts-cache 负责（fonts.load 自身也带缓存）。
 */
export function loadTerminalFontStages(fontId: string, fontSize: number): TerminalFontStages {
  const fonts = documentFonts();
  if (!fonts) {
    return NO_STAGES;
  }
  const entry = getFontEntry(fontId);
  if (!entry.isDefault) {
    injectFontFace(entry);
  }

  const first = loadFamily(fonts, entry.cssFamily, fontSize, FIRST_PAINT_SAMPLE_TEXT);

  // 完整文件那一面的触发字符从生成的互补范围里取，不在代码里硬编码某个 PUA 码位
  const subset: FontSubsetFiles | undefined = entry.isDefault ? entry.subset : undefined;
  const fullSample = subset ? sampleTextForRange(subset.fullUnicodeRange) : null;

  return {
    ready: settled(first),
    startUpgrade: () => {
      const rest = loadFamily(fonts, SYMBOL_FALLBACK, fontSize, FIRST_PAINT_SAMPLE_TEXT);
      if (fullSample) rest.push(...loadFamily(fonts, entry.cssFamily, fontSize, fullSample));
      return settled(rest);
    },
  };
}

/**
 * 一次把指定字体的全部字形加载齐（两段都等）。
 *
 * 给**不在冷启动关键路径上**的调用方用：字体选择器预览、分享回放——它们是用户显式打开的，
 * 且都用 canvas 渲染（canvas 不会像 DOM 文本那样自己触发 font-display:swap 的按需下载），
 * 少了 Nerd 图标那一段就会一直显示兜底字形。
 * 终端启动走 loadTerminalFontStages：首帧只等第一段，二段等首屏落地后再启动。
 */
export async function loadTerminalFonts(fontId: string, fontSize: number): Promise<void> {
  const stages = loadTerminalFontStages(fontId, fontSize);
  await stages.ready;
  await stages.startUpgrade?.();
}
