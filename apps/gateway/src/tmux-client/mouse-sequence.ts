/**
 * press/release 为按键；hover 为无按键移动（仅 1003）；drag 为按住按键移动（1002/1003）；wheel 为滚轮
 */
export type MouseReportKind = 'press' | 'release' | 'hover' | 'drag' | 'wheel';

export interface MouseSequence {
  bytes: Uint8Array;
  kind: MouseReportKind;
  droppable: boolean;
  motionKey: string | null;
}

const ESC = 0x1b;
const CSI_OPEN = 0x5b;
const SGR_MARK = 0x3c;
const X10_MARK = 0x4d;
const UPPER_M = 0x4d;
const LOWER_M = 0x6d;
const SEMICOLON = 0x3b;
const LEGACY_OFFSET = 32;

export function classifyMouseButton(code: number, release: boolean): MouseReportKind {
  if (release) return 'release';
  if (code > 255) return 'press';
  if ((code & 32) !== 0) return (code & 3) === 3 ? 'hover' : 'drag';
  if (code >= 64 && code <= 95) return 'wheel';
  return 'press';
}

interface ParsedReport {
  end: number;
  code: number;
  release: boolean;
  /** SGR 才区分 M/m；旧编码只有 M */
  final: 'M' | 'm';
}

function parseDigits(data: Uint8Array, start: number): { value: number; end: number } | null {
  let end = start;
  let value = 0;
  while (end < data.length && data[end] >= 0x30 && data[end] <= 0x39) {
    value = value * 10 + (data[end] - 0x30);
    end += 1;
  }
  return end === start ? null : { value, end };
}

/** 解析 `b;x;y` 三个十进制参数，返回终止字节位置 */
function parseTriple(data: Uint8Array, start: number): { code: number; end: number } | null {
  const code = parseDigits(data, start);
  if (!code || data[code.end] !== SEMICOLON) return null;
  const col = parseDigits(data, code.end + 1);
  if (!col || data[col.end] !== SEMICOLON) return null;
  const row = parseDigits(data, col.end + 1);
  return row ? { code: code.value, end: row.end } : null;
}

function parseSgr(data: Uint8Array, start: number): ParsedReport | null {
  const triple = parseTriple(data, start);
  if (!triple) return null;
  const final = data[triple.end];
  if (final !== UPPER_M && final !== LOWER_M) return null;
  const release = final === LOWER_M;
  return { end: triple.end + 1, code: triple.code, release, final: release ? 'm' : 'M' };
}

/** X10/普通编码：ESC [ M Cb Cx Cy，三个字节都至少是 32 */
function parseX10(data: Uint8Array, start: number): ParsedReport | null {
  if (start + 3 > data.length) return null;
  for (let index = start; index < start + 3; index += 1) {
    if (data[index] < LEGACY_OFFSET) return null;
  }
  return legacyReport(data[start] - LEGACY_OFFSET, start + 3);
}

/** urxvt 1015 编码：ESC [ Cb ; x ; y M，Cb 同样带 32 偏移 */
function parseUrxvt(data: Uint8Array, start: number): ParsedReport | null {
  const triple = parseTriple(data, start);
  if (!triple || data[triple.end] !== UPPER_M || triple.code < LEGACY_OFFSET) return null;
  return legacyReport(triple.code - LEGACY_OFFSET, triple.end + 1);
}

/** 旧编码没有释放按键号：低两位为 3 且不是移动即释放 */
function legacyReport(code: number, end: number): ParsedReport {
  const release = (code & 32) === 0 && (code & 64) === 0 && (code & 3) === 3;
  return { end, code, release, final: 'M' };
}

function parseReport(data: Uint8Array, offset: number): ParsedReport | null {
  if (data[offset] !== ESC || data[offset + 1] !== CSI_OPEN) return null;
  const marker = data[offset + 2];
  if (marker === SGR_MARK) return parseSgr(data, offset + 3);
  if (marker === X10_MARK) return parseX10(data, offset + 3);
  return parseUrxvt(data, offset + 2);
}

function toSequence(data: Uint8Array, offset: number, report: ParsedReport): MouseSequence {
  const { code, final } = report;
  const kind = classifyMouseButton(code, report.release);
  return {
    bytes: data.slice(offset, report.end),
    kind,
    motionKey:
      final === 'M' && code <= 255 && (code & 32) !== 0 && (code & 64) === 0
        ? `${code}:${final}`
        : null,
    droppable: final === 'M' && kind === 'wheel',
  };
}

/** 整段输入只由完整鼠标上报组成时逐条拆开，否则返回 null（按普通输入处理） */
export function splitMouseSequences(data: Uint8Array): MouseSequence[] | null {
  if (data[0] !== ESC) return null;
  const sequences: MouseSequence[] = [];
  let offset = 0;
  while (offset < data.length) {
    const report = parseReport(data, offset);
    if (!report) return null;
    sequences.push(toSequence(data, offset, report));
    offset = report.end;
  }
  return sequences;
}
