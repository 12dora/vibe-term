// `vibeterm term attach` 的转义键状态机（ssh 那一套）：行首的 `~` 开一个转义，
// 下一个字符决定动作；`~~` 发一个字面 `~`，其余字符原样连同 `~` 一起发出去。
//
// 纯状态机，不碰 TTY 也不碰 socket，attach 的交互逻辑因此可以单测。

import { UsageError } from './errors';

export type EscapeAction =
  | { type: 'send'; data: string }
  | { type: 'detach' }
  | { type: 'help' }
  | { type: 'windows' }
  | { type: 'select-window'; index: number };

export interface DetachKey {
  /** 空串表示关闭转义（`--detach-key none`）。 */
  escapeChar: string;
  detachChar: string;
}

export const DEFAULT_DETACH_KEY = '~.';

/** `~.` → `{escapeChar:'~', detachChar:'.'}`；`none` / `off` 关闭转义。 */
export function parseDetachKey(spec: string | undefined): DetachKey {
  const raw = (spec ?? DEFAULT_DETACH_KEY).trim();
  if (raw === 'none' || raw === 'off') return { escapeChar: '', detachChar: '' };
  const chars = [...raw];
  if (chars.length !== 2) {
    throw new UsageError(
      `--detach-key expects exactly two characters (e.g. "~."), got "${raw}"`,
      'use "none" to disable the escape sequence entirely'
    );
  }
  return { escapeChar: chars[0], detachChar: chars[1] };
}

/** 转义帮助文本，`~?` 打印。 */
export function escapeHelpLines(key: DetachKey): string[] {
  if (!key.escapeChar) return ['escape sequences are disabled (--detach-key none)'];
  const e = key.escapeChar;
  return [
    'supported escape sequences (type at the start of a line):',
    `  ${e}${key.detachChar}  detach (leave the pane running)`,
    `  ${e}w  list the windows of this session`,
    `  ${e}<n>${e}  switch to window <n> (a bare ${e}<n> switches on the next key)`,
    `  ${e}?  this message`,
    `  ${e}${e}  send a literal ${e}`,
  ];
}

function isLineBreak(char: string): boolean {
  return char === '\r' || char === '\n';
}

const MAX_WINDOW_DIGITS = 4;

type Emit = (data: string) => void;
type Act = (action: EscapeAction) => void;

/**
 * 逐字符喂输入，吐出动作。`send` 会把相邻字符合并成一条，避免每个按键一帧。
 * 行首判定与 ssh 一致：刚开始、或上一个字符是 CR / LF 时算行首。
 *
 * 窗口序号收多位：`~12~` / `~12` + 回车都切到 12 号窗口；`~1` 后面跟别的字符时，
 * 先切 1 号窗口，那个字符再照常发下去。
 */
export class DetachEscapeMatcher {
  private atLineStart = true;
  private pending = false;
  private digits: string | null = null;

  constructor(private readonly key: DetachKey) {}

  push(input: string): EscapeAction[] {
    const actions: EscapeAction[] = [];
    let buffer = '';
    const flush = (): void => {
      if (!buffer) return;
      actions.push({ type: 'send', data: buffer });
      buffer = '';
    };
    const emit: Emit = (data) => {
      buffer += data;
    };
    const act: Act = (action) => {
      flush();
      actions.push(action);
    };
    for (const char of input) this.step(char, emit, act);
    flush();
    return actions;
  }

  private step(char: string, emit: Emit, act: Act): void {
    if (!this.key.escapeChar) {
      emit(char);
      return;
    }
    if (this.digits !== null) {
      this.resolveDigits(char, emit, act);
      return;
    }
    if (this.pending) {
      this.pending = false;
      this.resolveEscape(char, emit, act);
      return;
    }
    if (this.atLineStart && char === this.key.escapeChar) {
      this.pending = true;
      return;
    }
    this.atLineStart = isLineBreak(char);
    emit(char);
  }

  private resolveEscape(char: string, emit: Emit, act: Act): void {
    if (char === this.key.detachChar) {
      act({ type: 'detach' });
      return;
    }
    if (char === this.key.escapeChar) {
      this.atLineStart = false;
      emit(this.key.escapeChar);
      return;
    }
    if (char === '?') {
      act({ type: 'help' });
      return;
    }
    if (char === 'w') {
      act({ type: 'windows' });
      return;
    }
    if (/^[0-9]$/.test(char)) {
      this.digits = char;
      return;
    }
    this.atLineStart = isLineBreak(char);
    emit(this.key.escapeChar + char);
  }

  /** 数字继续攒；`~` 或回车是终止符（吃掉），其余字符先落地切窗口再照常处理。 */
  private resolveDigits(char: string, emit: Emit, act: Act): void {
    const digits = this.digits ?? '';
    if (/^[0-9]$/.test(char) && digits.length < MAX_WINDOW_DIGITS) {
      this.digits = digits + char;
      return;
    }
    this.digits = null;
    act({ type: 'select-window', index: Number(digits) });
    if (char === this.key.escapeChar || isLineBreak(char)) return;
    this.step(char, emit, act);
  }
}
