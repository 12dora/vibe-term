// `vibeterm exec`：在设备上以独立进程跑命令（非交互，真实退出码）。

import { type FlagValues, flagBool, flagNumber, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import {
  EXEC_INLINE_HINT_BYTES,
  EXEC_MAX_MAX_BYTES,
  EXEC_MIN_MAX_BYTES,
  EXEC_STREAM_CLOSED,
  type ExecCollect,
  type ExecResult,
  ExecStreamClosedError,
  createExecCollect,
  execProcessExit,
  runExecRequest,
} from '../core/exec-client';
import { parseTarget } from '../core/resolve';
import { resolveTargetDevice } from '../core/term-target';
import { buildExecBody } from './exec-body';
import { type ExecFiles, closeExecFiles, openExecFiles, writeSink } from './exec-sink';
import type { Command } from './types';

const FLAGS = {
  cwd: 'string',
  env: 'strings',
  stdin: 'boolean',
  'stdin-file': 'string',
  shell: 'boolean',
  stream: 'boolean',
  script: 'string',
  interpreter: 'string',
  'max-bytes': 'number',
  tail: 'number',
  'stdout-file': 'string',
  'stderr-file': 'string',
} as const;

const USAGE = `用法：
  vibeterm exec [--node <node>] [<node>/]<device> [--cwd <dir>] [--env K=V]...
                [--stdin | --stdin-file <path> | @<path>] [--timeout <ms>] [--shell]
                [--script <path>] [--interpreter <bin>] [--max-bytes N] [--tail N]
                [--stdout-file <path>] [--stderr-file <path>] -- <argv...>

在设备上以独立进程运行命令（不经过共享 pane）。local 设备走 Bun.spawn，
ssh 设备走 OpenSSH BatchMode。shell:true 时 argv 只能有一项，经 /bin/sh -c
执行（不用 bash -lc）。

  --cwd <dir>            工作目录
  --env K=V              覆盖环境变量，可重复
  --stdin                把 stdin 作为进程 stdin
  --stdin-file <path>    从文件读 stdin
  @<path>                -- 之前最后一个 token，等价 --stdin-file
  --script <path>        把文件作为 stdin，argv 默认 /bin/sh -s；与 argv / --shell / --stdin* 互斥
  --interpreter <bin>    覆盖 --script 的解释器（仍带 -s）
  --timeout <ms>         只约束远端子进程墙上时钟。只有显式给出时才写入请求体 timeoutMs。
                         省略则由网关默认 600000（10 分钟），上限 3600000。不控制 HTTP 空闲。
  --shell                argv 只有一项，交给 /bin/sh -c
  --max-bytes N          每路输出的服务端上限（1 KiB .. 8 MiB）；超出后 truncated 且子进程继续
  --tail N               JSON 字段只保留每路最后 N 字节（先应用服务端 --max-bytes）
  --stdout-file <path>   边收边写入文件；JSON 用 stdoutPath/stdoutBytes，不含内联字符串
  --stderr-file <path>   同上，对应 stderr
  --json                 结束后打一个 JSON 对象到 stdout
  --json --stream        原样转发服务端 NDJSON 事件（含 ping）

非 TTY 或缺省 --json：stdout 为一行
  {exitCode, signal, stdout, stderr, durationMs, truncated, reason}
reason 为 exit | timeout | error。流在 exit 前断开时 --json 为
  {ok:false, code:"EXEC_STREAM_CLOSED", reason, elapsedMs, stdoutBytes, stderrBytes}
  以及（若用了文件）stdoutPath/stderrPath，退出码 5。
TTY 且未 --json 时 stdout/stderr 按块写回本机对应 fd，CLI 退出码 = 远端退出码
（timeout → 124；校验/网络错误 → 2/4/3/5）。`;

interface ParsedExecArgs {
  flags: FlagValues;
  target: string;
  commandArgv: string[];
  atFile: string | null;
  maxBytes: number | undefined;
  tailBytes: number | undefined;
}

function splitDashDash(argv: string[]): { head: string[]; tail: string[] | null } {
  const index = argv.indexOf('--');
  if (index < 0) return { head: [...argv], tail: null };
  return { head: argv.slice(0, index), tail: argv.slice(index + 1) };
}

function takeAtFile(positionals: string[]): { rest: string[]; file: string | null } {
  if (positionals.length === 0) return { rest: positionals, file: null };
  const last = positionals[positionals.length - 1];
  if (!last.startsWith('@')) return { rest: positionals, file: null };
  const file = last.slice(1);
  if (!file) throw new UsageError('@file path is empty');
  return { rest: positionals.slice(0, -1), file };
}

function parseByteBound(
  flags: FlagValues,
  key: string,
  min: number,
  max: number
): number | undefined {
  const raw = flagNumber(flags, key);
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new UsageError(`--${key} must be an integer between ${min} and ${max}`);
  }
  return raw;
}

function assertScriptExclusive(
  flags: FlagValues,
  commandArgv: string[],
  atFile: string | null
): void {
  if (commandArgv.length > 0) {
    throw new UsageError('--script cannot be combined with a command argv');
  }
  if (flagBool(flags, 'shell')) {
    throw new UsageError('--script cannot be combined with --shell');
  }
  if (flagBool(flags, 'stdin') || flagString(flags, 'stdin-file') || atFile) {
    throw new UsageError('--script cannot be combined with --stdin, --stdin-file, or @path');
  }
}

function assertExecArgv(flags: FlagValues, commandArgv: string[], atFile: string | null): void {
  if (flagString(flags, 'script')) {
    assertScriptExclusive(flags, commandArgv, atFile);
    return;
  }
  if (flagString(flags, 'interpreter')) {
    throw new UsageError('--interpreter requires --script');
  }
  if (commandArgv.length === 0) {
    throw new UsageError('vibeterm exec needs a command after --');
  }
  if (flagBool(flags, 'shell') && commandArgv.length !== 1) {
    throw new UsageError('--shell requires exactly one argv element (the script for /bin/sh -c)');
  }
}

function parseExecArgs(argv: string[]): ParsedExecArgs {
  const { head, tail } = splitDashDash(argv);
  const { flags, positionals } = parseArgv(head, FLAGS);
  const { rest, file: atFile } = takeAtFile(positionals);
  const target = rest[0];
  if (!target) throw new UsageError('vibeterm exec needs a device target', USAGE);
  const extra = rest.slice(1);
  const commandArgv = tail ?? extra;
  if (tail && extra.length > 0) {
    throw new UsageError('put the command after --', 'vibeterm exec <device> -- <argv...>');
  }
  assertExecArgv(flags, commandArgv, atFile);
  return {
    flags,
    target,
    commandArgv,
    atFile,
    maxBytes: parseByteBound(flags, 'max-bytes', EXEC_MIN_MAX_BYTES, EXEC_MAX_MAX_BYTES),
    tailBytes: parseByteBound(flags, 'tail', 1, EXEC_MAX_MAX_BYTES),
  };
}

function jsonPayload(result: ExecResult): unknown {
  const row: Record<string, unknown> = {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    truncated: result.truncated,
    reason: result.reason,
  };
  if (result.stdoutPath) {
    row.stdoutPath = result.stdoutPath;
    row.stdoutBytes = result.stdoutBytes;
  } else {
    row.stdout = result.stdout;
  }
  if (result.stderrPath) {
    row.stderrPath = result.stderrPath;
    row.stderrBytes = result.stderrBytes;
  } else {
    row.stderr = result.stderr;
  }
  return row;
}

function hintLargeInline(ctx: CliContext, result: ExecResult): void {
  if (result.stdoutPath === null && result.stdoutBytes > EXEC_INLINE_HINT_BYTES) {
    ctx.out.warn(
      `stdout is ${result.stdoutBytes} bytes; pass --tail N or --stdout-file <path> to keep JSON small`
    );
  }
  if (result.stderrPath === null && result.stderrBytes > EXEC_INLINE_HINT_BYTES) {
    ctx.out.warn(
      `stderr is ${result.stderrBytes} bytes; pass --tail N or --stderr-file <path> to keep JSON small`
    );
  }
}

function emitStreamClosedJson(
  ctx: CliContext,
  error: ExecStreamClosedError,
  files: ExecFiles
): void {
  const row: Record<string, unknown> = {
    ok: false,
    code: EXEC_STREAM_CLOSED,
    reason: error.reason,
    elapsedMs: error.elapsedMs,
    stdoutBytes: error.stdoutBytes,
    stderrBytes: error.stderrBytes,
  };
  if (files.stdoutPath) row.stdoutPath = files.stdoutPath;
  if (files.stderrPath) row.stderrPath = files.stderrPath;
  ctx.out.line(JSON.stringify(row));
}

function collectOptions(parsed: ParsedExecArgs, files: ExecFiles): ExecCollect {
  return createExecCollect({
    tailBytes: parsed.tailBytes,
    omitStdout: Boolean(files.stdoutPath),
    omitStderr: Boolean(files.stderrPath),
  });
}

function bindLive(
  ctx: CliContext,
  asJson: boolean,
  files: ExecFiles
): {
  stdout: (bytes: Uint8Array) => Promise<void>;
  stderr: (bytes: Uint8Array) => Promise<void>;
} | null {
  if (asJson && !files.stdout && !files.stderr) return null;
  return {
    stdout: async (bytes) => {
      await writeSink(files.stdout, bytes);
      if (!asJson) ctx.out.raw(bytes);
    },
    stderr: async (bytes) => {
      await writeSink(files.stderr, bytes);
      if (!asJson) ctx.out.rawErr(bytes);
    },
  };
}

function warnScriptFallback(ctx: CliContext, fallback: string | null): void {
  if (!fallback) return;
  ctx.out.warn(`script shebang interpreter ${fallback} is not a supported shell; using /bin/sh -s`);
}

function printJsonResult(
  ctx: CliContext,
  asJson: boolean,
  stream: boolean,
  result: ExecResult
): void {
  if (!asJson || stream) return;
  ctx.out.line(JSON.stringify(jsonPayload(result)));
  hintLargeInline(ctx, result);
}

function reportStreamClosed(
  ctx: CliContext,
  asJson: boolean,
  error: unknown,
  files: ExecFiles
): void {
  if (error instanceof ExecStreamClosedError && asJson) emitStreamClosedJson(ctx, error, files);
}

async function runParsed(
  ctx: CliContext,
  parsedArgs: ParsedExecArgs,
  files: ExecFiles,
  asJson: boolean,
  stream: boolean
): Promise<number> {
  const parsed = await resolveTargetDevice(ctx, parsedArgs.target);
  const built = await buildExecBody(ctx, parsed.device.id, parsedArgs);
  warnScriptFallback(ctx, built.scriptFallback);
  const result = await runExecRequest(ctx, parsed.nodeId, built.body, {
    live: bindLive(ctx, asJson, files),
    streamJson: stream ? (event) => ctx.out.line(JSON.stringify(event)) : null,
    collect: collectOptions(parsedArgs, files),
  });
  result.stdoutPath = files.stdoutPath;
  result.stderrPath = files.stderrPath;
  printJsonResult(ctx, asJson, stream, result);
  return execProcessExit(result);
}

async function run(ctx: CliContext, argv: string[]): Promise<number> {
  const parsedArgs = parseExecArgs(argv);
  if (parseTarget(parsedArgs.target).location) {
    throw new UsageError('vibeterm exec does not take a window/pane location');
  }
  const stream = flagBool(parsedArgs.flags, 'stream');
  if (stream && !ctx.globals.json) throw new UsageError('--stream requires --json');
  const asJson = ctx.globals.json || !ctx.out.isStdoutTty();
  const files = openExecFiles(parsedArgs.flags);
  let runError: unknown;
  let exitCode = 0;
  try {
    exitCode = await runParsed(ctx, parsedArgs, files, asJson, stream);
  } catch (error) {
    reportStreamClosed(ctx, asJson, error, files);
    runError = error;
  } finally {
    const closeError = await closeExecFiles(files);
    if (runError === undefined && closeError !== undefined) runError = closeError;
  }
  if (runError !== undefined) throw runError;
  return exitCode;
}

export const command: Command = {
  name: 'exec',
  summary: '在设备上以独立进程运行命令（非交互，真实退出码）',
  usage: USAGE,
  flags: FLAGS,
  run,
};
