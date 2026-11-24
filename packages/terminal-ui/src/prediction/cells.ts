import type { PredictionCell, PredictionFrame } from 'ghostty-terminal';

/** 单次提交超过该字素数按粘贴处理，不预测 */
export const PREDICTION_MAX_GRAPHEMES = 32;

export interface Position {
  row: number;
  col: number;
}

export interface Prediction extends Position {
  text: string;
  wide: boolean;
  erase: boolean;
  epoch: number;
  bornAt: number;
  minCol: number;
  /** 被同格后续按键覆盖掉的旧预测内容：服务端尚未处理后续按键时允许出现 */
  prior: string[];
}

export interface RunCell extends Position {
  text: string;
  wide: boolean;
  /** 暂定 epoch 里目标格有内容（自动建议），只占位不预测 */
  skipped?: boolean;
}

/**
 * suspect = 光标位置看起来不对，但可能是重绘途中的瞬时笔位；
 * gone = 预测行已滚出视口，静默丢弃。
 */
export type Verdict = 'confirmed' | 'mismatch' | 'suspect' | 'pending' | 'gone';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 识别控制字符正是目的
export const BACKSPACE_RE = /^[\x7f\x08]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 识别控制字符正是目的
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

let segmenter: Intl.Segmenter | null | undefined;

function splitGraphemes(text: string): string[] {
  if (segmenter === undefined) {
    segmenter =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** 纯可打印单行文本拆成字素；含控制字符或过长（粘贴）返回 null */
export function printableGraphemes(data: string): string[] | null {
  if (!data || CONTROL_RE.test(data)) return null;
  const graphemes = splitGraphemes(data);
  return graphemes.length > PREDICTION_MAX_GRAPHEMES ? null : graphemes;
}

export function isPredictionSuppressed(frame: PredictionFrame): boolean {
  return (
    frame.altScreen ||
    frame.cursor.passwordInput ||
    !frame.cursor.visible ||
    frame.mouseReporting ||
    frame.synchronizedOutput ||
    !frame.viewportAtBottom
  );
}

export function isBlank(cell: PredictionCell | null): boolean {
  return !cell || cell.text === '' || cell.text === ' ';
}

/** 空白 / 擦除预测与任意空格子都「相等」，不能作为把 epoch 转为可见的证据 */
export function isSubstantive(prediction: Prediction): boolean {
  return !prediction.erase && prediction.text.trim() !== '';
}

export function span(cell: { wide: boolean }): number {
  return cell.wide ? 2 : 1;
}

export function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

export function cursorPosition(frame: PredictionFrame): Position {
  return { row: frame.viewportTop + frame.cursor.row, col: frame.cursor.col };
}

export function overlaps(prediction: Prediction, row: number, col: number, width: number): boolean {
  return (
    prediction.row === row &&
    prediction.col < col + width &&
    col < prediction.col + span(prediction)
  );
}

export function inViewport(frame: PredictionFrame, row: number): boolean {
  const viewportRow = row - frame.viewportTop;
  return viewportRow >= 0 && viewportRow < frame.rows;
}

export function cellMatches(prediction: Prediction, frame: PredictionFrame): boolean {
  const row = prediction.row - frame.viewportTop;
  const cell = frame.cellAt(row, prediction.col);
  if (!prediction.erase) return cell?.text === prediction.text;
  return isBlank(cell) && (!prediction.wide || isBlank(frame.cellAt(row, prediction.col + 1)));
}

export function judgeOnCursorRow(
  prediction: Prediction,
  frame: PredictionFrame,
  matches: boolean
): Verdict {
  const cursorCol = frame.cursor.col;
  if (cursorCol < prediction.minCol) return 'suspect';
  // 擦除以光标退回为准：自动建议可能立刻把同一格重新画上
  if (prediction.erase) return cursorCol <= prediction.col ? 'confirmed' : 'pending';
  if (cursorCol < prediction.col + span(prediction)) return 'pending';
  if (matches) return 'confirmed';
  const text = frame.cellAt(prediction.row - frame.viewportTop, prediction.col)?.text ?? '';
  return prediction.prior.includes(text) ? 'pending' : 'suspect';
}

export function collectPrior(covered: readonly Prediction[]): string[] {
  const prior: string[] = [];
  for (const p of covered) {
    if (p.text) prior.push(p.text);
    prior.push(...p.prior);
  }
  return prior;
}

/** 跳过的占位格在真实光标越过它之前都还没落定 */
export function skipPending(cell: RunCell, cursor: Position): boolean {
  if (!cell.skipped) return false;
  return cursor.row !== cell.row || cursor.col < cell.col + span(cell);
}
