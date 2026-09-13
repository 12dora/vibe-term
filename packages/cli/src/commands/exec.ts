// `vibeterm exec`：在设备上以独立进程跑命令（非交互，真实退出码）。

import { type WriteStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  type FlagValues,
  flagBool,
  flagNumber,
  flagString,
  flagStrings,
  parseArgv,
} from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import {
  EXEC_INLINE_HINT_BYTES,
  EXEC_MAX_MAX_BYTES,
  EXEC_MIN_MAX_BYTES,
  EXEC_STREAM_CLOSED,
  type ExecCollect,
  type ExecRequestBody,
  type ExecResult,
  ExecStreamClosedError,
  MAX_EXEC_STDIN_BYTES,
  MAX_EXEC_TIMEOUT_MS,
  createExecCollect,
  execProcessExit,
  runExecRequest,
} from '../core/exec-client';
import { readAllStdin } from '../core/prompt';
import { resolveTargetDevice } from '../core/term-target';
import type { Command } from './types';

const SCRIPT_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

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
  {ok:false, code:"EXEC_STREAM_CLOSED", reason, elapsedMs}，退出码 5。
TTY 且未 --json 时 stdout/stderr 按块写回本机对应 fd，CLI 退出码 = 远端退出码
（timeout → 124；校验/网络错误 → 2/4/3/5）。`;

function splitDashDash(argv: string[]): { head: string[]; tail: string[] | null } {
  const index = argv.indexOf('--');
  if (index < 0) return { head: [...argv], tail: null };
  return { head: argv.slice(0, index), tail: argv.slice(index + 1) };
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`invalid --env ${pair}`, 'use K=V');
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

function execTimeoutMs(ctx: CliContext): number | undefined {
  if (!ctx.globals.timeoutExplicit) return undefined;
  const raw = ctx.globals.timeoutMs;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new UsageError(`--timeout must be a positive integer, got ${raw}`);
  }
  return Math.min(raw, MAX_EXEC_TIMEOUT_MS);
}

function takeAtFile(positionals: string[]): { rest: string[]; file: string | null } {
  if (positionals.length === 0) return { rest: positionals, file: null };
  const last = positionals[positionals.length - 1];
  if (!last.startsWith('@')) return { rest: positionals, file: null };
  const file = last.slice(1);
  if (!file) throw new UsageError('@file path is empty');
  return { rest: positionals.slice(0, -1), file };
}

function requireStdinSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength <= MAX_EXEC_STDIN_BYTES) return bytes;
  throw new UsageError(
    `stdin is ${bytes.byteLength} bytes (max ${MAX_EXEC_STDIN_BYTES} ≈ 0.75 MiB); copy the file with vibeterm cp and read it on the device`
  );
}

async function readStdinBytes(
  flags: FlagValues,
  atFile: string | null
): Promise<Uint8Array | null> {
  const file = flagString(flags, 'stdin-file') ?? atFile;
  if (flagBool(flags, 'stdin') && file) {
    throw new UsageError('use only one of --stdin, --stdin-file, or @path');
  }
  if (flagBool(flags, 'stdin')) {
    return requireStdinSize(Buffer.from(await readAllStdin(), 'utf8'));
  }
  if (!file) return null;
  return requireStdinSize(new Uint8Array(await readFile(file)));
}

function stdinField(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function interpreterFromShebang(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 2 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  let end = 0;
  while (end < bytes.byteLength && bytes[end] !== 0x0a) end += 1;
  const line = Buffer.from(bytes.subarray(2, end)).toString('utf8').trim();
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
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
  if (shebang) return { argv: ['/bin/sh', '-s'], fallback: shebang };
  return { argv: ['/bin/sh', '-s'], fallback: null };
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

function parseExecArgs(argv: string[]): {
  flags: FlagValues;
  target: string;
  commandArgv: string[];
  atFile: string | null;
} {
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
  return { flags, target, commandArgv, atFile };
}

async function readScriptBody(
  path: string,
  interpreter: string | undefined
): Promise<{ argv: string[]; stdin: Uint8Array; fallback: string | null }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`cannot read --script ${path}: ${detail}`);
  }
  requireStdinSize(bytes);
  const resolved = scriptArgv(interpreterFromShebang(bytes), interpreter);
  return { argv: resolved.argv, stdin: bytes, fallback: resolved.fallback };
}

async function buildExecBody(
  ctx: CliContext,
  deviceId: string,
  parsed: ReturnType<typeof parseExecArgs>
): Promise<{ body: ExecRequestBody; scriptFallback: string | null }> {
  const script = flagString(parsed.flags, 'script');
  const envPairs = parseEnvPairs(flagStrings(parsed.flags, 'env'));
  const cwd = flagString(parsed.flags, 'cwd');
  const timeoutMs = execTimeoutMs(ctx);
  const maxBytes = parseByteBound(
    parsed.flags,
    'max-bytes',
    EXEC_MIN_MAX_BYTES,
    EXEC_MAX_MAX_BYTES
  );
  const extras: Pick<ExecRequestBody, 'timeoutMs' | 'cwd' | 'env' | 'maxBytes'> = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(envPairs).length > 0 ? { env: envPairs } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
  if (script) {
    const loaded = await readScriptBody(script, flagString(parsed.flags, 'interpreter'));
    return {
      scriptFallback: loaded.fallback,
      body: {
        deviceId,
        argv: loaded.argv,
        stdin: stdinField(loaded.stdin),
        ...extras,
      },
    };
  }
  const stdinBytes = await readStdinBytes(parsed.flags, parsed.atFile);
  return {
    scriptFallback: null,
    body: {
      deviceId,
      argv: parsed.commandArgv,
      ...extras,
      ...(stdinBytes ? { stdin: stdinField(stdinBytes) } : {}),
      ...(flagBool(parsed.flags, 'shell') ? { shell: true } : {}),
    },
  };
}

type FileSink = { path: string; stream: WriteStream };

function openSink(path: string): FileSink {
  return { path, stream: createWriteStream(path) };
}

function writeSink(sink: FileSink | undefined, bytes: Uint8Array): void {
  if (!sink) return;
  sink.stream.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

async function closeSink(sink: FileSink | undefined): Promise<void> {
  if (!sink) return;
  await new Promise<void>((resolve, reject) => {
    sink.stream.end((error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  });
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

function emitStreamClosedJson(ctx: CliContext, error: ExecStreamClosedError): void {
  ctx.out.line(
    JSON.stringify({
      ok: false,
      code: EXEC_STREAM_CLOSED,
      reason: error.reason,
      elapsedMs: error.elapsedMs,
    })
  );
}

function collectOptions(
  flags: FlagValues,
  stdoutPath: string | null,
  stderrPath: string | null
): ExecCollect {
  return createExecCollect({
    tailBytes: parseByteBound(flags, 'tail', 1, EXEC_MAX_MAX_BYTES),
    omitStdout: Boolean(stdoutPath),
    omitStderr: Boolean(stderrPath),
  });
}

type ExecFiles = {
  stdoutPath: string | null;
  stderrPath: string | null;
  stdout: FileSink | undefined;
  stderr: FileSink | undefined;
};

function openExecFiles(flags: FlagValues): ExecFiles {
  const stdoutPath = flagString(flags, 'stdout-file') ?? null;
  const stderrPath = flagString(flags, 'stderr-file') ?? null;
  return {
    stdoutPath,
    stderrPath,
    stdout: stdoutPath ? openSink(stdoutPath) : undefined,
    stderr: stderrPath ? openSink(stderrPath) : undefined,
  };
}

function bindLive(
  ctx: CliContext,
  asJson: boolean,
  files: ExecFiles
): { stdout: (bytes: Uint8Array) => void; stderr: (bytes: Uint8Array) => void } | null {
  if (asJson && !files.stdout && !files.stderr) return null;
  return {
    stdout: (bytes) => {
      writeSink(files.stdout, bytes);
      if (!asJson) ctx.out.raw(bytes);
    },
    stderr: (bytes) => {
      writeSink(files.stderr, bytes);
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

function reportStreamClosed(ctx: CliContext, asJson: boolean, error: unknown): void {
  if (error instanceof ExecStreamClosedError && asJson) emitStreamClosedJson(ctx, error);
}

async function run(ctx: CliContext, argv: string[]): Promise<number> {
  const parsedArgs = parseExecArgs(argv);
  const parsed = await resolveTargetDevice(ctx, parsedArgs.target);
  if (parsed.target.location) {
    throw new UsageError('vibeterm exec does not take a window/pane location');
  }
  const stream = flagBool(parsedArgs.flags, 'stream');
  if (stream && !ctx.globals.json) throw new UsageError('--stream requires --json');
  const asJson = ctx.globals.json || !ctx.out.isStdoutTty();
  const files = openExecFiles(parsedArgs.flags);
  try {
    const built = await buildExecBody(ctx, parsed.device.id, parsedArgs);
    warnScriptFallback(ctx, built.scriptFallback);
    const result = await runExecRequest(ctx, parsed.nodeId, built.body, {
      live: bindLive(ctx, asJson, files),
      streamJson: stream ? (event) => ctx.out.line(JSON.stringify(event)) : null,
      collect: collectOptions(parsedArgs.flags, files.stdoutPath, files.stderrPath),
    });
    result.stdoutPath = files.stdoutPath;
    result.stderrPath = files.stderrPath;
    printJsonResult(ctx, asJson, stream, result);
    return execProcessExit(result);
  } catch (error) {
    reportStreamClosed(ctx, asJson, error);
    throw error;
  } finally {
    await closeSink(files.stdout);
    await closeSink(files.stderr);
  }
}

export const command: Command = {
  name: 'exec',
  summary: '在设备上以独立进程运行命令（非交互，真实退出码）',
  usage: USAGE,
  flags: FLAGS,
  run,
};
