// `vibeterm exec`：在设备上以独立进程跑命令（非交互，真实退出码）。

import { readFile } from 'node:fs/promises';
import { type FlagValues, flagBool, flagString, flagStrings, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import {
  type ExecRequestBody,
  MAX_EXEC_TIMEOUT_MS,
  execProcessExit,
  runExecRequest,
} from '../core/exec-client';
import { readAllStdin } from '../core/prompt';
import { resolveTargetDevice } from '../core/term-target';
import type { Command } from './types';

const FLAGS = {
  cwd: 'string',
  env: 'strings',
  stdin: 'boolean',
  'stdin-file': 'string',
  shell: 'boolean',
  stream: 'boolean',
} as const;

const USAGE = `用法：
  vibeterm exec [--node <node>] [<node>/]<device> [--cwd <dir>] [--env K=V]...
                [--stdin | --stdin-file <path> | @<path>] [--timeout <ms>] [--shell] -- <argv...>

在设备上以独立进程运行命令（不经过共享 pane）。local 设备走 Bun.spawn，
ssh 设备走 OpenSSH BatchMode。shell:true 时 argv 只能有一项，经 /bin/sh -c
执行（不用 bash -lc）。

  --cwd <dir>            工作目录
  --env K=V              覆盖环境变量，可重复
  --stdin                把 stdin 作为进程 stdin
  --stdin-file <path>    从文件读 stdin
  @<path>                -- 之前最后一个 token，等价 --stdin-file
  --timeout <ms>         全局旗标；只有显式给出时才写入请求体 timeoutMs。省略则由网关默认 600000（10 分钟），上限 3600000
  --shell                argv 只有一项，交给 /bin/sh -c
  --json                 结束后打一个 JSON 对象到 stdout
  --json --stream        原样转发服务端 NDJSON 事件

非 TTY 或缺省 --json：stdout 为一行
  {exitCode, signal, stdout, stderr, durationMs, truncated, reason}
reason 为 exit | timeout | error。TTY 且未 --json 时 stdout/stderr 按块写回本机
对应 fd，CLI 退出码 = 远端退出码（timeout → 124；校验/网络错误 → 2/4/3/5）。`;

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

async function readStdinBytes(
  flags: FlagValues,
  atFile: string | null
): Promise<Uint8Array | null> {
  const file = flagString(flags, 'stdin-file') ?? atFile;
  if (flagBool(flags, 'stdin') && file) {
    throw new UsageError('use only one of --stdin, --stdin-file, or @path');
  }
  if (flagBool(flags, 'stdin')) {
    return Buffer.from(await readAllStdin(), 'utf8');
  }
  if (!file) return null;
  return new Uint8Array(await readFile(file));
}

function stdinField(bytes: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

function jsonPayload(result: {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  truncated: { stdout: boolean; stderr: boolean };
  reason: string;
}): unknown {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    truncated: result.truncated,
    reason: result.reason,
  };
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
  if (commandArgv.length === 0) throw new UsageError('vibeterm exec needs a command after --');
  if (flagBool(flags, 'shell') && commandArgv.length !== 1) {
    throw new UsageError('--shell requires exactly one argv element (the script for /bin/sh -c)');
  }
  return { flags, target, commandArgv, atFile };
}

async function buildExecBody(
  ctx: CliContext,
  deviceId: string,
  parsed: ReturnType<typeof parseExecArgs>
): Promise<ExecRequestBody> {
  const stdinBytes = await readStdinBytes(parsed.flags, parsed.atFile);
  const envPairs = parseEnvPairs(flagStrings(parsed.flags, 'env'));
  const cwd = flagString(parsed.flags, 'cwd');
  const timeoutMs = execTimeoutMs(ctx);
  return {
    deviceId,
    argv: parsed.commandArgv,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(envPairs).length > 0 ? { env: envPairs } : {}),
    ...(stdinBytes ? { stdin: stdinField(stdinBytes) } : {}),
    ...(flagBool(parsed.flags, 'shell') ? { shell: true } : {}),
  };
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
  const live =
    asJson || stream
      ? null
      : {
          stdout: (bytes: Uint8Array) => ctx.out.raw(bytes),
          stderr: (bytes: Uint8Array) => ctx.out.rawErr(bytes),
        };
  const streamJson = stream ? (event: unknown) => ctx.out.line(JSON.stringify(event)) : null;
  const body = await buildExecBody(ctx, parsed.device.id, parsedArgs);
  const result = await runExecRequest(ctx, parsed.nodeId, body, live, streamJson);
  if (asJson && !stream) ctx.out.line(JSON.stringify(jsonPayload(result)));
  return execProcessExit(result);
}

export const command: Command = {
  name: 'exec',
  summary: '在设备上以独立进程运行命令（非交互，真实退出码）',
  usage: USAGE,
  flags: FLAGS,
  run,
};
