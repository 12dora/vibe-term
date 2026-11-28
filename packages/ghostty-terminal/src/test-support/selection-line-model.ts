// 把纯文本铺成全窄字符的渲染行，再走生产接口 buildLineModel 生成 SelectionLineModel。
// selection-model.test.ts、link-detector.test.ts、terminal.canvas.test.ts、explicit 链接测试共享。
import { type SelectionLineModel, buildLineModel } from '../selection-model';
import type { GhosttyRenderCell } from '../types';

const NEUTRAL_STYLE = {
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
} as const;

function narrowCell(text: string, x: number): GhosttyRenderCell {
  return {
    x,
    text,
    codepoints: Array.from(text, (ch) => ch.codePointAt(0) ?? 0),
    widthKind: 'narrow',
    hasText: text.trim().length > 0,
    hasHyperlink: false,
    style: { ...NEUTRAL_STYLE },
    fgColor: null,
    bgColor: null,
  };
}

/** hyperlinkAt(x) 为 true 的列带 OSC 8 标记，供 explicit 链接测试铺行。 */
export function cellsFromText(
  text: string,
  hyperlinkAt: (x: number) => boolean = () => false
): GhosttyRenderCell[] {
  return Array.from(text, (ch, x) => ({ ...narrowCell(ch, x), hasHyperlink: hyperlinkAt(x) }));
}

export function lineModelFromText(text: string, wrappedToNext = false): SelectionLineModel {
  return buildLineModel(Array.from(text, narrowCell), wrappedToNext);
}
