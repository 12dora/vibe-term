// `vibeterm exec`：在设备上跑命令，行为对齐 `ssh host cmd`（原样 stdio、退出码透传、断线续传）。

import type { ExecCommand } from '@vibeterm/shared/exec-channel';
import {
  type FlagValues,
  GLOBAL_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  flagStrings,
  parseArgv,
} from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { type ExecChannelResult, exitCodeOf } from '../core/exec-channel';
import {
  EXEC_INLINE_HINT_BYTES,
  EXEC_MAX_MAX_BYTES,
  EXEC_MIN_MAX_BYTES,
  EXEC_STREAM_CLOSED,
  ExecStreamClosedError,
} from '../core/exec-client';
import {
  type RemoteRunOptions,
  type RemoteRunSinks,
  type StdinMode,
  type TtyMode,
  runRemote,
} from '../core/remote-run';
import {
  type CommandMode,
  commandFromWords,
  execTimeoutMs,
  parseEnvPairs,
  rewriteExecArgv,
  scriptCommand,
} from './exec-body';
import {
  type ExecFiles,
  StreamCollector,
  closeExecFiles,
  openExecFiles,
  writeSink,
} from './exec-sink';
import type { Command } from './types';

const FLAGS = {
  cwd: 'string',
  env: 'strings',
  stdin: 'boolean',
  'stdin-file': 'strings',
  'no-stdin': 'boolean',
  shell: 'boolean',
  sh: 'boolean',
  tty: 'boolean',
  'force-tty': 'boolean',
  'no-tty': 'boolean',
  verbose: 'boolean',
  argv: 'boolean',
  stream: 'boolean',
  script: 'string',
  interpreter: 'string',
  'max-bytes': 'number',
  tail: 'number',
  'stdout-file': 'string',
  'stderr-file': 'string',
} as const;

const USAGE = `用法：
  vibeterm exec [选项] <目标> [命令 [参数...]]

在设备上运行命令，用法与 ssh 一致：stdin / stdout / stderr 原样透传（二进制安全、不限大小），
退出码即远端退出码（信号为 128+n，超时为 124），链路中断后自动重连并续传输出。

目标：
  <node>               该节点的默认设备（第一台 local 设备）
  <node>/<device>      指定节点上的设备（名称或 id）
  <device>             入口节点上的设备

命令：
  （省略）             登录 shell：在终端中为交互会话；stdin 是管道时按脚本执行
  命令 [参数...]       用空格拼接后交给目标用户的 shell（$SHELL -c），与 ssh 相同
  -- 命令 [参数...]    精确 argv，不经 shell
  命令之后的内容（包括 -la 这类）原样属于命令，选项必须写在命令之前。

选项：
  -t, --tty            分配伪终端（-tt 或重复 -t：即使 stdin 不是终端也强制分配）
  -T, --no-tty         不分配伪终端
  -n, --no-stdin       不读取 stdin（命令的 stdin 为空）
  --stdin-file <path>  从文件读 stdin（目标后紧跟 @<path> 等价）
  --script <path>      把本地脚本作为 stdin 交给解释器（取 shebang，缺省 /bin/sh -s）
  --interpreter <bin>  覆盖 --script 的解释器（仍带 -s）
  --sh                 用 /bin/sh -c 代替目标用户的 shell
  --shell              兼容旧用法：与 --sh 相同；配合 -- 时只接受一项（脚本）
  --cwd <dir>          工作目录（缺省为用户主目录）
  --env K=V            设置环境变量，可重复
  --timeout <ms>       限制命令墙上时钟；缺省不限时
  --stdout-file <path> 输出写入文件（0600），不再写 stdout
  --stderr-file <path> 同上，对应 stderr
  -v, --verbose        显示所选设备与重连提示
  -q, --quiet          不打印提示与警告

stdin：非终端时自动转发（管道 / 重定向 / heredoc），终端上不读取；伪终端下终端即输入。

JSON 模式：
  --json               等待结束后输出一个 JSON 对象
                       {exitCode, signal, stdout, stderr, durationMs, truncated, reason}
  --max-bytes N        每路内联输出的上限（1 KiB .. 8 MiB，缺省 8 MiB），超出后 truncated
  --tail N             每路只保留最后 N 字节
  --json --stream      逐块输出 NDJSON 事件 {type:"stdout"|"stderr", base64} 与 {type:"exit", ...}

示例：
  vibeterm exec box uname -a
  vibeterm exec box 'pg_dump -Fc db' > db.dump
  vibeterm exec box 'tar -C /data -cf - dir' | tar -xf -
  cat big.tar | vibeterm exec box 'tar -C /srv -xf -'
  vibeterm exec box 'bash -s' <<'EOF'
  set -e; hostname
  EOF
  vibeterm exec -t box sudo systemctl status app
  vibeterm exec --json box 'df -h'

需要 ssh 的工具（rsync、git、scp 等）请使用 vibeterm rsh。`;

type ExecArgs = {
  flags: FlagValues;
  target: string;
  words: string[];
  mode: CommandMode;
};

function splitAtDashDash(argv: string[]): { head: string[]; tail: string[] | null } {
  const index = argv.indexOf('--');
  if (index < 0) return { head: [...argv], tail: null };
  return { head: argv.slice(0, index), tail: argv.slice(index + 1) };
}

function parseExecArgs(argv: string[]): ExecArgs {
  const { head, tail } = splitAtDashDash(argv);
  const { flags, positionals } = parseArgv(head, FLAGS);
  const target = positionals[0];
  if (!target) throw new UsageError('vibeterm exec needs a target', USAGE);
  const extra = positionals.slice(1);
  if (tail && extra.length > 0) {
    throw new UsageError('put the command after --', 'vibeterm exec <target> -- <argv...>');
  }
  const mode: CommandMode = {
    exact: tail !== null && flagBool(flags, 'argv'),
    shell: flagBool(flags, 'shell'),
    sh: flagBool(flags, 'sh'),
  };
  return { flags, target, words: tail ?? extra, mode };
}

function byteBound(flags: FlagValues, key: string, min: number): number | undefined {
  const raw = flagNumber(flags, key);
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < min || raw > EXEC_MAX_MAX_BYTES) {
    throw new UsageError(`--${key} must be an integer between ${min} and ${EXEC_MAX_MAX_BYTES}`);
  }
  return raw;
}

function ttyMode(flags: FlagValues): TtyMode {
  const always = flagBool(flags, 'force-tty');
  const force = flagBool(flags, 'tty');
  if (flagBool(flags, 'no-tty')) {
    if (always || force) throw new UsageError('-t and -T cannot be combined');
    return 'no';
  }
  if (always) return 'always';
  return force ? 'force' : 'auto';
}

function stdinFile(flags: FlagValues): string | undefined {
  const files = flagStrings(flags, 'stdin-file');
  if (files.length > 1) throw new UsageError('use only one of --stdin-file or @path');
  const file = files[0];
  if (files.length === 1 && !file) throw new UsageError('--stdin-file path is empty');
  return file;
}

function stdinMode(flags: FlagValues, file: string | undefined): StdinMode {
  if (flagBool(flags, 'no-stdin')) {
    if (file) throw new UsageError('-n cannot be combined with --stdin-file');
    return 'none';
  }
  return file ? { file } : 'auto';
}

function assertScriptExclusive(args: ExecArgs): void {
  const { flags } = args;
  if (args.words.length > 0) {
    throw new UsageError('--script cannot be combined with a command');
  }
  if (flagBool(flags, 'shell') || flagBool(flags, 'sh')) {
    throw new UsageError('--script cannot be combined with --shell or --sh');
  }
  if (flagBool(flags, 'stdin') || flagBool(flags, 'no-stdin') || stdinFile(flags)) {
    throw new UsageError('--script cannot be combined with --stdin, --stdin-file, -n, or @path');
  }
}

type Launch = {
  command: ExecCommand;
  stdin: StdinMode;
  scriptFallback: string | null;
};

async function planLaunch(args: ExecArgs): Promise<Launch> {
  const script = flagString(args.flags, 'script');
  if (!script) {
    if (flagString(args.flags, 'interpreter')) {
      throw new UsageError('--interpreter requires --script');
    }
    return {
      command: commandFromWords(args.words, args.mode),
      stdin: stdinMode(args.flags, stdinFile(args.flags)),
      scriptFallback: null,
    };
  }
  assertScriptExclusive(args);
  const loaded = await scriptCommand(script, flagString(args.flags, 'interpreter'));
  return { command: loaded.command, stdin: { file: script }, scriptFallback: loaded.fallback };
}

type JsonPlan = {
  enabled: boolean;
  stream: boolean;
  maxBytes: number;
  tailBytes: number | undefined;
};

function planJson(ctx: CliContext, flags: FlagValues): JsonPlan {
  const enabled = ctx.globals.json;
  const stream = flagBool(flags, 'stream');
  const maxBytes = byteBound(flags, 'max-bytes', EXEC_MIN_MAX_BYTES);
  const tailBytes = byteBound(flags, 'tail', 1);
  if (!enabled) {
    if (stream) throw new UsageError('--stream requires --json');
    if (maxBytes !== undefined) throw new UsageError('--max-bytes requires --json');
    if (tailBytes !== undefined) throw new UsageError('--tail requires --json');
  }
  return { enabled, stream, maxBytes: maxBytes ?? EXEC_MAX_MAX_BYTES, tailBytes };
}

type Collectors = { stdout: StreamCollector; stderr: StreamCollector };

type OutputPlan = {
  sinks: Partial<RemoteRunSinks>;
  finish(result: ExecChannelResult): void;
};

function fileSinks(files: ExecFiles): Partial<RemoteRunSinks> {
  return {
    ...(files.stdout ? { stdout: (bytes: Uint8Array) => writeSink(files.stdout, bytes) } : {}),
    ...(files.stderr ? { stderr: (bytes: Uint8Array) => writeSink(files.stderr, bytes) } : {}),
  };
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

type StreamName = 'stdout' | 'stderr';
const STREAMS: readonly StreamName[] = ['stdout', 'stderr'];

function pathOf(files: ExecFiles, name: StreamName): string | null {
  return name === 'stdout' ? files.stdoutPath : files.stderrPath;
}

function jsonPayload(result: ExecChannelResult, files: ExecFiles, c: Collectors): unknown {
  const row: Record<string, unknown> = {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    truncated: { stdout: c.stdout.truncated, stderr: c.stderr.truncated },
    reason: result.reason,
  };
  for (const name of STREAMS) {
    const path = pathOf(files, name);
    if (path) {
      row[`${name}Path`] = path;
      row[`${name}Bytes`] = c[name].bytes;
    } else {
      row[name] = c[name].text();
    }
  }
  return row;
}

function hintLargeInline(ctx: CliContext, files: ExecFiles, c: Collectors): void {
  for (const name of STREAMS) {
    if (pathOf(files, name) === null && c[name].bytes > EXEC_INLINE_HINT_BYTES) {
      ctx.out.warn(
        `${name} is ${c[name].bytes} bytes; pass --tail N or --${name}-file <path> to keep JSON small`
      );
    }
  }
}

function jsonOutput(ctx: CliContext, json: JsonPlan, files: ExecFiles): OutputPlan {
  const collect = (name: StreamName) =>
    new StreamCollector({
      inline: !pathOf(files, name) && !json.stream,
      maxBytes: json.maxBytes,
      tailBytes: json.tailBytes,
    });
  const collectors: Collectors = { stdout: collect('stdout'), stderr: collect('stderr') };
  const tee = (name: StreamName) => async (bytes: Uint8Array) => {
    await writeSink(files[name], bytes);
    collectors[name].push(bytes);
    if (json.stream) ctx.out.line(JSON.stringify({ type: name, base64: base64Of(bytes) }));
  };
  return {
    sinks: { stdout: tee('stdout'), stderr: tee('stderr') },
    finish(result) {
      if (json.stream) {
        const { exitCode: code, signal, durationMs, reason } = result;
        ctx.out.line(JSON.stringify({ type: 'exit', code, signal, durationMs, reason }));
        return;
      }
      ctx.out.line(JSON.stringify(jsonPayload(result, files, collectors)));
      hintLargeInline(ctx, files, collectors);
    },
  };
}

function buildOutput(ctx: CliContext, json: JsonPlan, files: ExecFiles): OutputPlan {
  if (json.enabled) return jsonOutput(ctx, json, files);
  return { sinks: fileSinks(files), finish: () => {} };
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

export type ExecDeps = {
  run: (ctx: CliContext, options: RemoteRunOptions) => Promise<ExecChannelResult>;
};

async function execute(deps: ExecDeps, ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseExecArgs(argv);
  const json = planJson(ctx, args.flags);
  const launch = await planLaunch(args);
  const options: RemoteRunOptions = {
    target: args.target,
    command: launch.command,
    ...(flagString(args.flags, 'cwd') ? { cwd: flagString(args.flags, 'cwd') } : {}),
    env: parseEnvPairs(flagStrings(args.flags, 'env')),
    tty: ttyMode(args.flags),
    stdin: launch.stdin,
    timeoutMs: execTimeoutMs(ctx),
    verbose: flagBool(args.flags, 'verbose'),
    legacyFallback: true,
  };
  if (launch.scriptFallback) {
    ctx.out.warn(
      `script shebang interpreter ${launch.scriptFallback} is not a supported shell; using /bin/sh -s`
    );
  }
  const files = openExecFiles(args.flags);
  let failure: unknown;
  let exitCode = 0;
  try {
    const output = buildOutput(ctx, json, files);
    const result = await deps.run(ctx, { ...options, sinks: output.sinks });
    output.finish(result);
    exitCode = exitCodeOf(result);
  } catch (error) {
    if (error instanceof ExecStreamClosedError && json.enabled) {
      emitStreamClosedJson(ctx, error, files);
    }
    failure = error;
  } finally {
    const closeError = await closeExecFiles(files);
    if (failure === undefined && closeError !== undefined) failure = closeError;
  }
  if (failure !== undefined) throw failure;
  return exitCode;
}

const SPEC = { ...GLOBAL_FLAGS, ...FLAGS };

export function buildExecCommand(deps: ExecDeps = { run: runRemote }): Command {
  return {
    name: 'exec',
    summary: '在设备上运行命令（用法同 ssh：原样 stdio、退出码透传）',
    usage: USAGE,
    flags: FLAGS,
    preprocessArgv: (argv) => rewriteExecArgv(argv, SPEC),
    run: (ctx, argv) => execute(deps, ctx, argv),
  };
}

export const command: Command = buildExecCommand();
