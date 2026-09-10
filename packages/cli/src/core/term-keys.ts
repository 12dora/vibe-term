// `vibeterm term send` 的按键名 → 字节序列。名字与 `tmux send-keys` 一致
// （`Enter`、`C-c`、`M-x`、`S-Up`、`F5`…），认不出的词按字面文本发。
//
// wire 上的 TerminalInput 载荷是 UTF-8 字节，所以这里产出的是字符串：
// 终端按键序列全在 ASCII 范围内，字面文本按 UTF-8 编码，两者都不会丢字节。

import { UsageError } from './errors';

const ESC = '\u001b';

/** 不带修饰键时的原始序列。 */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  return: '\r',
  escape: ESC,
  esc: ESC,
  tab: '\t',
  btab: `${ESC}[Z`,
  space: ' ',
  bspace: '\u007f',
  backspace: '\u007f',
  delete: `${ESC}[3~`,
  dc: `${ESC}[3~`,
  insert: `${ESC}[2~`,
  ic: `${ESC}[2~`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  pageup: `${ESC}[5~`,
  ppage: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  npage: `${ESC}[6~`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
};

/** F1–F4 用 SS3，F5 起用 CSI `~`（xterm 惯例）。 */
const FUNCTION_KEYS: Readonly<Record<number, string>> = {
  1: `${ESC}OP`,
  2: `${ESC}OQ`,
  3: `${ESC}OR`,
  4: `${ESC}OS`,
  5: `${ESC}[15~`,
  6: `${ESC}[17~`,
  7: `${ESC}[18~`,
  8: `${ESC}[19~`,
  9: `${ESC}[20~`,
  10: `${ESC}[21~`,
  11: `${ESC}[23~`,
  12: `${ESC}[24~`,
};

const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;

interface ParsedKeyName {
  mods: number;
  base: string;
}

/** 拆 `C-`/`M-`/`S-` 前缀；base 只剩一个字符时不再往下拆（`C-C-` 这种写法不存在）。 */
function parseModifiers(name: string): ParsedKeyName {
  let mods = 0;
  let base = name;
  while (base.length > 2) {
    const head = base.slice(0, 2).toUpperCase();
    if (head === 'C-') mods |= MOD_CTRL;
    else if (head === 'M-') mods |= MOD_ALT;
    else if (head === 'S-') mods |= MOD_SHIFT;
    else break;
    base = base.slice(2);
  }
  return { mods, base };
}

/** Ctrl + 单字符 → C0 控制码；`C-@`/`C-Space` = NUL，`C-?` = DEL。 */
export function controlByte(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.codePointAt(0) ?? 0;
  if (char === '?') return '\u007f';
  if (char === '@' || char === ' ') return '\u0000';
  const upper = char.toUpperCase().codePointAt(0) ?? 0;
  if (upper >= 0x41 && upper <= 0x5a) return String.fromCharCode(upper - 0x40);
  if (code >= 0x5b && code <= 0x5f) return String.fromCharCode(code - 0x40);
  return null;
}

/** 给 CSI / SS3 序列套上 xterm 的修饰键参数（`\e[1;5A` 之类）。 */
function withModifierParam(sequence: string, mods: number): string {
  const param = mods + 1;
  if (sequence.startsWith(`${ESC}O`) && sequence.length === 3) {
    return `${ESC}[1;${param}${sequence[2]}`;
  }
  if (!sequence.startsWith(`${ESC}[`)) return sequence;
  const body = sequence.slice(2);
  if (body.endsWith('~')) return `${ESC}[${body.slice(0, -1)};${param}~`;
  if (body.length === 1) return `${ESC}[1;${param}${body}`;
  return sequence;
}

function functionKey(base: string): string | null {
  const match = /^[fF]([1-9]|1[0-2])$/.exec(base);
  if (!match) return null;
  return FUNCTION_KEYS[Number(match[1])] ?? null;
}

function baseSequence(base: string): string | null {
  const named = NAMED_KEYS[base.toLowerCase()];
  if (named !== undefined) return named;
  return functionKey(base);
}

function applyModifiers(sequence: string, mods: number, base: string): string {
  if (mods === 0) return sequence;
  if (sequence.startsWith(ESC) && sequence.length > 1) return withModifierParam(sequence, mods);
  // 普通字符：Shift 先抬成大写，Ctrl 再降成控制码，Alt 最后加 ESC 前缀。
  let text = sequence;
  if (mods & MOD_SHIFT) text = text.toUpperCase();
  if (mods & MOD_CTRL) {
    const control = controlByte(text);
    if (control === null) throw new UsageError(`key "${base}" has no control form`);
    text = control;
  }
  return mods & MOD_ALT ? `${ESC}${text}` : text;
}

/** 一个按键名 → 字节序列；认不出返回 null（由调用方决定是否按字面发）。 */
export function keyNameToSequence(name: string): string | null {
  if (!name) return null;
  const direct = baseSequence(name);
  if (direct !== null) return direct;
  const { mods, base } = parseModifiers(name);
  if (mods === 0) return null;
  const sequence = baseSequence(base) ?? (base.length === 1 ? base : null);
  if (sequence === null) return null;
  return applyModifiers(sequence, mods, base);
}

export interface KeysToSequenceOptions {
  /** 全部按字面文本发，不查按键名表；参数之间补一个空格。 */
  literal?: boolean;
}

/** 一串参数 → 要发的字符串。非 literal 时参数之间不插空格（与 `tmux send-keys` 一致）。 */
export function keysToSequence(
  keys: readonly string[],
  options: KeysToSequenceOptions = {}
): string {
  if (options.literal) return keys.join(' ');
  let out = '';
  for (const key of keys) {
    out += keyNameToSequence(key) ?? key;
  }
  return out;
}

const REPLACEMENT = '�';

/** `--hex` 的十六进制串 → 字符串。字节按 UTF-8 解释，非法 UTF-8 直接报用法错误。 */
export function hexToSequence(input: string): string {
  const clean = input.replace(/[\s,:]/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new UsageError(`--hex expects an even number of hex digits, got "${input}"`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.includes(REPLACEMENT) && !clean.toLowerCase().includes('efbfbd')) {
    throw new UsageError(
      '--hex bytes are not valid UTF-8',
      'TerminalInput carries UTF-8 text, so bytes >= 0x80 must form valid UTF-8'
    );
  }
  return text;
}
