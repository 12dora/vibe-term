// exec 的参数层：OpenSSH 风格的 argv 改写（选项在目标前后、命令原样）、命令与 --script 的构造。

import { open } from 'node:fs/promises';
import type { ExecCommand } from '@vibeterm/shared/exec-channel';
import type { FlagSpec } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';

const SCRIPT_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHEBANG_PROBE_BYTES = 512;
/** 通道协议允许的最长子进程墙上时钟（30 天）。 */
export const MAX_CHANNEL_TIMEOUT_MS = 30 * 24 * 3600 * 1000;

export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`invalid --env ${pair}`, 'use K=V');
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/** `--timeout 0`（不限时）改写成的隐藏开关：全局解析只认正整数，0 不能走全局旗标。 */
export const NO_TIMEOUT_FLAG = 'no-timeout';

/** 只有显式 `--timeout` 才限时；缺省的 30 s 是请求超时，不是命令超时；`--timeout 0` 不限时。 */
export function execTimeoutMs(ctx: CliContext, noTimeout = false): number | undefined {
  if (noTimeout || !ctx.globals.timeoutExplicit) return undefined;
  const raw = ctx.globals.timeoutMs;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new UsageError(`--timeout must be a positive integer, got ${raw}`);
  }
  return Math.min(raw, MAX_CHANNEL_TIMEOUT_MS);
}

const SHORT_FLAGS: Readonly<Record<string, string>> = {
  T: '--no-tty',
  n: '--no-stdin',
  v: '--verbose',
  q: '--quiet',
};

type Rewrite = {
  head: string[];
  ttyCount: number;
  targetSeen: boolean;
  noTimeout: boolean;
};

/** -t / -T 以最后一个为准（ssh 语义）：-T 清掉此前的 -t 计数，-t 撤销此前的 -T。 */
function applyTty(state: Rewrite, letter: 't' | 'T'): void {
  if (letter === 'T') {
    state.ttyCount = 0;
    if (!state.head.includes('--no-tty')) state.head.push('--no-tty');
    return;
  }
  state.ttyCount += 1;
  state.head = state.head.filter((word) => word !== '--no-tty');
}

function expandCluster(token: string, state: Rewrite): void {
  for (const letter of token.slice(1)) {
    if (letter === 't' || letter === 'T') {
      applyTty(state, letter);
      continue;
    }
    const long = SHORT_FLAGS[letter];
    if (!long) {
      throw new UsageError(
        `unknown option: -${letter}`,
        'options go before the command; everything after the first command word belongs to the command'
      );
    }
    state.head.push(long);
  }
}

const LONG_TTY: Readonly<Record<string, readonly ('t' | 'T')[]>> = {
  '--tty': ['t'],
  '--no-tty': ['T'],
  '--force-tty': ['t', 't'],
};

/** `--timeout 0` / `--timeout=0`：返回该选项最后一个 token 的下标，否则 null。 */
export function zeroTimeoutEnd(argv: readonly string[], index: number): number | null {
  const token = argv[index];
  const isZero = (text: string | undefined): boolean =>
    text !== undefined && text.trim() !== '' && Number(text) === 0;
  if (token.startsWith('--timeout='))
    return isZero(token.slice('--timeout='.length)) ? index : null;
  if (token !== '--timeout') return null;
  const next = argv[index + 1];
  return next !== undefined && !next.startsWith('-') && isZero(next) ? index + 1 : null;
}

/** 取值型长选项连同下一个 token 一起收下（与派发层一致：以 `-` 开头的不算取值）。 */
function takeLongOption(
  argv: readonly string[],
  index: number,
  spec: FlagSpec,
  state: Rewrite
): number {
  const token = argv[index];
  const tty = LONG_TTY[token];
  if (tty) {
    for (const letter of tty) applyTty(state, letter);
    return index;
  }
  const zero = zeroTimeoutEnd(argv, index);
  if (zero !== null) {
    state.noTimeout = true;
    return zero;
  }
  if (token === '--timeout' || token.startsWith('--timeout=')) state.noTimeout = false;
  state.head.push(token);
  if (token.includes('=')) return index;
  const kind = spec[token.slice(2)];
  const next = argv[index + 1];
  if (!kind || kind === 'boolean' || next === undefined || next.startsWith('-')) return index;
  state.head.push(next);
  return index + 1;
}

function assemble(state: Rewrite, words: readonly string[], explicit: boolean): string[] {
  const out = [...state.head];
  if (state.ttyCount === 1) out.push('--tty');
  if (state.ttyCount > 1) out.push('--force-tty');
  if (state.noTimeout) out.push(`--${NO_TIMEOUT_FLAG}`);
  if (explicit) out.push('--argv');
  if (explicit || words.length > 0) out.push('--', ...words);
  return out;
}

/**
 * OpenSSH 的参数形状：`exec [选项] <目标> [选项] [命令 参数...]`。第一个非选项词是目标，
 * 目标之后第一个非选项词起一律是命令（含 `-la` 这类）。在命令前插入 `--`；用户自己写了
 * `--` 时额外加隐藏的 `--argv`（精确 argv，不经 shell）。`-t/-tt/-T/-n/-v/-q` 改写成长选项，
 * 目标后紧跟的 `@path` 等价 `--stdin-file`。
 */
export function rewriteExecArgv(argv: readonly string[], spec: FlagSpec): string[] {
  const state: Rewrite = { head: [], ttyCount: 0, targetSeen: false, noTimeout: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') return assemble(state, argv.slice(index + 1), true);
    if (token === '-h') {
      state.head.push(token);
    } else if (token.startsWith('--')) {
      index = takeLongOption(argv, index, spec, state);
    } else if (token.length > 1 && token.startsWith('-')) {
      expandCluster(token, state);
    } else if (!state.targetSeen) {
      state.targetSeen = true;
      state.head.push(token);
    } else if (token.length > 1 && token.startsWith('@')) {
      state.head.push(`--stdin-file=${token.slice(1)}`);
    } else {
      return assemble(state, argv.slice(index), false);
    }
  }
  return assemble(state, [], false);
}

export type CommandMode = {
  /** 用户写了显式 `--`：精确 argv。 */
  exact: boolean;
  /** 旧 `--shell`：脚本交给 /bin/sh -c。 */
  shell: boolean;
  /** `--sh`：用 /bin/sh 而不是目标用户的 shell。 */
  sh: boolean;
};

function shellCommand(script: string, sh: boolean): ExecCommand {
  return sh ? { kind: 'shell', script, sh: true } : { kind: 'shell', script };
}

/** 没有命令词 → 登录 shell；`--` 精确 argv；其余像 ssh 一样用空格拼接交给 shell。 */
export function commandFromWords(words: readonly string[], mode: CommandMode): ExecCommand {
  if (words.length === 0) return { kind: 'login' };
  if (!mode.exact) return shellCommand(words.join(' '), mode.sh || mode.shell);
  if (!mode.shell) return { kind: 'argv', argv: [...words] };
  if (words.length !== 1) {
    throw new UsageError('--shell requires exactly one argv element (the script for /bin/sh -c)');
  }
  return shellCommand(words[0] as string, true);
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function interpreterFromShebang(head: Uint8Array): string | null {
  if (head.byteLength < 2 || head[0] !== 0x23 || head[1] !== 0x21) return null;
  let end = 0;
  while (end < head.byteLength && head[end] !== 0x0a) end += 1;
  const tokens = Buffer.from(head.subarray(2, end)).toString('utf8').trim().split(/\s+/);
  if (!tokens[0]) return null;
  if (/\/env$/.test(tokens[0]) && tokens[1]) return tokens[1];
  return tokens[0];
}

function scriptArgv(
  shebang: string | null,
  override: string | undefined
): { argv: string[]; fallback: string | null } {
  if (override) return { argv: [override, '-s'], fallback: null };
  if (shebang && SCRIPT_SHELLS.has(basenameOf(shebang))) {
    return { argv: [shebang, '-s'], fallback: null };
  }
  return { argv: ['/bin/sh', '-s'], fallback: shebang };
}

/** `--script`：文件作为 stdin，解释器取 shebang（仅 shell 类）或 `--interpreter`，只读开头探测。 */
export async function scriptCommand(
  path: string,
  interpreter: string | undefined
): Promise<{ command: ExecCommand; fallback: string | null }> {
  const head = Buffer.alloc(SHEBANG_PROBE_BYTES);
  let read = 0;
  try {
    const handle = await open(path, 'r');
    try {
      read = (await handle.read(head, 0, SHEBANG_PROBE_BYTES, 0)).bytesRead;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`cannot read --script ${path}: ${detail}`);
  }
  const resolved = scriptArgv(interpreterFromShebang(head.subarray(0, read)), interpreter);
  return { command: { kind: 'argv', argv: resolved.argv }, fallback: resolved.fallback };
}
