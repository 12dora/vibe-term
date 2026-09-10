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
    `  ${e}<n>  switch to window <n>`,
    `  ${e}?  this message`,
    `  ${e}${e}  send a literal ${e}`,
  ];
}

function isLineBreak(char: string): boolean {
  return char === '\r' || char === '\n';
}

/**
 * 逐字符喂输入，吐出动作。`send` 会把相邻字符合并成一条，避免每个按键一帧。
 * 行首判定与 ssh 一致：刚开始、或上一个字符是 CR / LF 时算行首。
 */
export class DetachEscapeMatcher {
  private atLineStart = true;
  private pending = false;

  constructor(private readonly key: DetachKey) {}

  push(input: string): EscapeAction[] {
    const actions: EscapeAction[] = [];
    let buffer = '';
    const flush = (): void => {
      if (!buffer) return;
      actions.push({ type: 'send', data: buffer });
      buffer = '';
    };
    for (const char of input) {
      const action = this.step(char, (data) => {
        buffer += data;
      });
      if (!action) continue;
      flush();
      actions.push(action);
    }
    flush();
    return actions;
  }

  /** 单个字符：要么把字节交给 `emit`，要么返回一个动作。 */
  private step(char: string, emit: (data: string) => void): EscapeAction | null {
    if (!this.key.escapeChar) {
      emit(char);
      return null;
    }
    if (this.pending) {
      this.pending = false;
      return this.resolveEscape(char, emit);
    }
    if (this.atLineStart && char === this.key.escapeChar) {
      this.pending = true;
      return null;
    }
    this.atLineStart = isLineBreak(char);
    emit(char);
    return null;
  }

  private resolveEscape(char: string, emit: (data: string) => void): EscapeAction | null {
    if (char === this.key.detachChar) return { type: 'detach' };
    if (char === this.key.escapeChar) {
      this.atLineStart = false;
      emit(this.key.escapeChar);
      return null;
    }
    if (char === '?') return { type: 'help' };
    if (char === 'w') return { type: 'windows' };
    if (/^[0-9]$/.test(char)) return { type: 'select-window', index: Number(char) };
    this.atLineStart = isLineBreak(char);
    emit(this.key.escapeChar + char);
    return null;
  }
}
