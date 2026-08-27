// 把纯文本铺成全窄字符的渲染行，再走生产接口 buildLineModel 生成 SelectionLineModel。
// selection-model.test.ts、link-detector.test.ts、terminal.canvas.test.ts 共享。
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
    style: { ...NEUTRAL_STYLE },
    fgColor: null,
    bgColor: null,
  };
}

export function lineModelFromText(text: string, wrappedToNext = false): SelectionLineModel {
  return buildLineModel(Array.from(text, narrowCell), wrappedToNext);
}
