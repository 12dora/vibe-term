// run_command 核心：在绑定 pane 里执行一条命令并拿到完整输出。
// 数据全部走实时流（emulator tap）：字节累积命令输出、OSC133 标记判完成、render 判 alternate。
// 三类目标（详见 docs）：
//  - POSIX：注入隐形 OSC133 + nonce 包裹命令，等带 nonce 的 D 标记 → 精确输出 + 退出码。
//  - CLI（网络设备）：学提示符 / 提示符重现判完成 / --More-- 自动续翻 / 错误串启发（无退出码）。
//  - TUI/alternate：拒绝（entered_tui），交回交互式读写屏。

import type { PromptMarker } from '../../tmux-client/pane-stream-parser';
import {
  compileOptionalRegex,
  resolvePromptRegex,
  resolveRunCommandArgs,
} from './run-command-args';
import { createByteOutputBuffer } from './run-command-buffer';
import {
  applyDisablePaging,
  attachRunCommandTap,
  buildRunCommandPayload,
  resolveRunCommandRuntime,
} from './run-command-spawn';
import { cleanTerminalText, lastNonEmptyLine } from './run-command-text';

export { cleanTerminalText } from './run-command-text';

export type RunCommandMode = 'auto' | 'posix' | 'cli';
export type RunCommandShell = 'bash' | 'zsh' | 'sh' | 'fish' | 'powershell';

export type RunCommandStatus =
  | 'completed'
  | 'timeout'
  | 'entered_tui'
  | 'expect_matched'
  | 'paused_pager';

export interface RunCommandResult {
  output: string;
  exitCode: number | null;
  status: RunCommandStatus;
  likelyError: boolean;
  errorLine?: string;
  truncated: boolean;
}

/** run_command 所需的 emulator 能力子集（便于以 fake 单测）。 */
export interface RunCommandEmulator {
  isAlternateScreen(): boolean;
  render(): string;
  tap(tap: {
    onBytes?: (data: Uint8Array) => void;
    onMarker?: (marker: PromptMarker) => void;
  }): () => void;
}

export interface RunCommandParams {
  command: string;
  mode?: RunCommandMode;
  shell?: RunCommandShell;
  /** cli 提示符正则（不传则从当前屏末行学习） */
  prompt?: string;
  /** 命中即早返回（密码提示 / [y/N] 等） */
  expect?: string;
  timeoutMs?: number;
  /** cli：先发该平台关分页命令 */
  disablePagingCommand?: string;
}

export type RunCommandSendInput = (data: string) => void | Promise<void>;

export interface RunCommandDeps {
  emulator: RunCommandEmulator;
  sendInput: RunCommandSendInput;
  sleepMs?: (ms: number) => Promise<void>;
  /** 注入 nonce（默认基于计数器；避免直接用 Math.random，便于测试） */
  makeNonce?: () => string;
  now?: () => number;
}

const POLL_MS = 50;
const MORE_MARKERS = [/--More--/, /---\(more[^)]*\)---/i, /<--- More --->/i, /\bMore: <space>/i];
const ERROR_PATTERNS = [
  /%\s*Invalid input/i,
  /%\s*Ambiguous command/i,
  /%\s*Incomplete command/i,
  /^\s*\^\s*$/m,
  /syntax error/i,
  /unknown command/i,
];

function enteredTuiResult(): RunCommandResult {
  return {
    output: '',
    exitCode: null,
    status: 'entered_tui',
    likelyError: false,
    truncated: false,
  };
}

// 从累积原始字节里剥掉第一行（命令回显），返回干净输出。
function extractOutput(raw: string, truncated: boolean): { text: string; truncated: boolean } {
  const cleaned = cleanTerminalText(raw);
  const newlineIdx = cleaned.indexOf('\n');
  // 第一行是 shell 对输入行的回显（含我们注入的 wrapper），剥掉
  const body = newlineIdx >= 0 ? cleaned.slice(newlineIdx + 1) : '';
  return { text: body.replace(/\n+$/, ''), truncated };
}

function detectError(text: string): { likelyError: boolean; errorLine?: string } {
  for (const pattern of ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.split('\n').find((l) => pattern.test(l)) ?? match[0];
      return { likelyError: true, errorLine: line.trim() };
    }
  }
  return { likelyError: false };
}

export async function executeRunCommand(
  params: RunCommandParams,
  deps: RunCommandDeps
): Promise<RunCommandResult> {
  const runtime = resolveRunCommandRuntime(deps);
  const args = resolveRunCommandArgs(params);

  if (deps.emulator.isAlternateScreen()) {
    return enteredTuiResult();
  }

  const buffer = createByteOutputBuffer();
  let nonce = '';
  const tap = attachRunCommandTap(deps.emulator, buffer, () => nonce);

  try {
    await applyDisablePaging({
      mode: args.mode,
      disablePagingCommand: args.disablePagingCommand,
      sendInput: deps.sendInput,
      sleepMs: runtime.sleepMs,
      resetBuffer: () => buffer.reset(),
    });
    const promptRegex = resolvePromptRegex(args, deps.emulator.render());
    if (args.usePosix) nonce = runtime.makeNonce();
    await deps.sendInput(
      buildRunCommandPayload({
        command: args.command,
        usePosix: args.usePosix,
        shell: args.shell,
        nonce,
      })
    );
    return await waitForCommandCompletion({
      emulator: deps.emulator,
      sendInput: deps.sendInput,
      sleepMs: runtime.sleepMs,
      now: runtime.now,
      deadline: runtime.now() + args.timeoutMs,
      usePosix: args.usePosix,
      getReceivedMarker: tap.getReceivedMarker,
      expectRegex: compileOptionalRegex(args.expectPattern),
      promptRegex,
      accumulated: () => buffer.decode(),
      getWasTruncated: () => buffer.wasTruncated(),
    });
  } finally {
    tap.untap();
  }
}

async function checkPager(cleanedNow: string, sendInput: RunCommandSendInput): Promise<boolean> {
  if (MORE_MARKERS.some((re) => re.test(cleanedNow.slice(-200)))) {
    await sendInput(' ');
    return true;
  }
  return false;
}

function checkPosixCompletion(
  usePosix: boolean,
  receivedMarker: PromptMarker | null,
  rawNow: string,
  truncated: boolean
): RunCommandResult | null {
  if (!usePosix || !receivedMarker) return null;
  const out = extractOutput(rawNow, truncated);
  const err = detectError(out.text);
  return {
    output: out.text,
    exitCode: receivedMarker.exitCode,
    status: 'completed',
    ...err,
    truncated: out.truncated,
  };
}

function checkPromptCompletion(
  promptRegex: RegExp | null,
  rawNow: string,
  truncated: boolean
): RunCommandResult | null {
  if (!promptRegex) return null;
  const tail = lastNonEmptyLine(rawNow);
  const out = extractOutput(rawNow, truncated);
  if (promptRegex.test(tail) && out.text.length > 0) {
    const err = detectError(out.text);
    return {
      output: out.text,
      exitCode: null,
      status: 'completed',
      ...err,
      truncated: out.truncated,
    };
  }
  return null;
}

interface CommandWaitParams {
  emulator: RunCommandEmulator;
  sendInput: RunCommandSendInput;
  sleepMs: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  usePosix: boolean;
  getReceivedMarker: () => PromptMarker | null;
  expectRegex: RegExp | null;
  promptRegex: RegExp | null;
  accumulated: () => string;
  getWasTruncated: () => boolean;
}

async function waitForCommandCompletion(params: CommandWaitParams): Promise<RunCommandResult> {
  let idleStableSince = 0;
  let lastLen = 0;

  while (params.now() < params.deadline) {
    await params.sleepMs(POLL_MS);

    if (params.emulator.isAlternateScreen()) {
      return {
        output: extractOutput(params.accumulated(), params.getWasTruncated()).text,
        exitCode: null,
        status: 'entered_tui',
        likelyError: false,
        truncated: false,
      };
    }

    const rawNow = params.accumulated();
    const cleanedNow = cleanTerminalText(rawNow);
    const truncated = params.getWasTruncated();

    if (params.expectRegex?.test(cleanedNow)) {
      const out = extractOutput(rawNow, truncated);
      return {
        output: out.text,
        exitCode: null,
        status: 'expect_matched',
        likelyError: false,
        truncated: out.truncated,
      };
    }

    const posix = checkPosixCompletion(
      params.usePosix,
      params.getReceivedMarker(),
      rawNow,
      truncated
    );
    if (posix) return posix;

    if (await checkPager(cleanedNow, params.sendInput)) {
      idleStableSince = 0;
      continue;
    }

    const prompt = checkPromptCompletion(params.promptRegex, rawNow, truncated);
    if (prompt) return prompt;

    if (rawNow.length === lastLen) {
      if (idleStableSince === 0) {
        idleStableSince = params.now();
      } else if (params.now() - idleStableSince >= 600) {
        const out = extractOutput(rawNow, truncated);
        if (out.text.length > 0 || params.now() - idleStableSince >= 1500) {
          const err = detectError(out.text);
          return {
            output: out.text,
            exitCode: null,
            status: 'completed',
            ...err,
            truncated: out.truncated,
          };
        }
      }
    } else {
      idleStableSince = 0;
      lastLen = rawNow.length;
    }
  }

  const out = extractOutput(params.accumulated(), params.getWasTruncated());
  return {
    output: out.text,
    exitCode: null,
    status: 'timeout',
    ...detectError(out.text),
    truncated: out.truncated,
  };
}
