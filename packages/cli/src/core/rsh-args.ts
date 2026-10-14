// `vibeterm rsh` 的参数解析：OpenSSH 的 getopt 语法（optstring
// "46AaCfGgKkMNnqsTtVvXxYyB:b:c:D:E:e:F:I:i:J:L:l:m:O:o:P:p:Q:R:S:W:w:"）。
// 旗标可成簇（-tt、-xq）、取值可贴着旗标（-p22、-oBatchMode=yes）；目标前后都能出现选项，
// 到第一个非选项词为止（OpenSSH 在目标之后会重新跑一遍 getopt）；`--` 结束选项。

import type { ExecCommand } from '@vibeterm/shared/exec-channel';
import { UsageError } from './errors';

export type RshTty = 'auto' | 'force' | 'always' | 'no';

export type RshInvocation = {
  /** vibeterm 目标：`<node>` | `<node>/<device>` | 入口上的设备名。 */
  target: string;
  /** `[user@]` 或 `-l` 给出的用户；vibeterm 以节点服务用户运行，仅 -v 时回显。 */
  user: string | null;
  command: ExecCommand;
  tty: RshTty;
  stdin: 'auto' | 'none';
  quiet: boolean;
  verbose: number;
  env: Record<string, string>;
};

/** `-G`：打印最小的 OpenSSH 风格配置后退出（git 靠它识别 OpenSSH 变体）。 */
export type RshConfigDump = { hostname: string; user: string; port: number };

export type RshParse =
  | { kind: 'version' }
  | { kind: 'config'; config: RshConfigDump }
  | { kind: 'run'; invocation: RshInvocation };

const NO_ARG = new Set('46AaCfGgKkMNnqsTtVvXxYy');
const WITH_ARG = new Set('BbcDEeFIiJLlmOoPpQRSWw');

const FORWARD_HINT = 'use vibeterm forward for port forwarding';
const REJECTED: Readonly<Record<string, string>> = {
  L: FORWARD_HINT,
  R: FORWARD_HINT,
  D: FORWARD_HINT,
  W: FORWARD_HINT,
  N: `a connection without a command is pointless; ${FORWARD_HINT}`,
  J: 'jump hosts are not supported; address the device as <node>/<device>',
  O: 'connection-multiplexing control commands are not supported',
  f: 'going to the background is not supported',
  Q: 'querying algorithms is not supported',
  w: 'tun device forwarding is not supported',
};

const DEFAULT_PORT = 22;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Env = Record<string, string | undefined>;

type ParseState = {
  user: string | null;
  subsystem: boolean;
  ttyFlag: RshTty | null;
  ttyOption: RshTty | null;
  stdinNone: boolean;
  quiet: boolean;
  verbose: number;
  version: boolean;
  printConfig: boolean;
  port: number;
  remoteCommand: string | null | undefined;
  setEnv: Record<string, string>;
  sendEnv: string[];
  /** 目标之前出现过 `--`：OpenSSH 此后不再解析选项（opt_terminated）。 */
  optionsEnded: boolean;
};

function newState(): ParseState {
  return {
    user: null,
    subsystem: false,
    ttyFlag: null,
    ttyOption: null,
    stdinNone: false,
    quiet: false,
    verbose: 0,
    version: false,
    printConfig: false,
    port: DEFAULT_PORT,
    remoteCommand: undefined,
    setEnv: {},
    sendEnv: [],
    optionsEnded: false,
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** ssh_config 值里以空白分隔的多项（SetEnv / SendEnv），支持双引号包住含空白的项。 */
function splitWords(value: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    words.push(match[1] ?? match[2]);
  }
  return words;
}

function parseRequestTty(value: string): RshTty {
  switch (value.toLowerCase()) {
    case 'yes':
    case 'true':
      return 'force';
    case 'force':
      return 'always';
    case 'no':
    case 'false':
      return 'no';
    case 'auto':
      return 'auto';
    default:
      throw new UsageError(`invalid RequestTTY value: ${value} (use yes, force, no or auto)`);
  }
}

function applySetEnv(state: ParseState, value: string): void {
  for (const word of splitWords(value)) {
    const eq = word.indexOf('=');
    const key = eq < 0 ? word : word.slice(0, eq);
    if (eq < 0 || !ENV_KEY.test(key)) {
      throw new UsageError(`invalid SetEnv value: ${word} (expected NAME=value)`);
    }
    // 与 ssh 一致：同名变量先出现者生效。
    if (!(key in state.setEnv)) state.setEnv[key] = word.slice(eq + 1);
  }
}

function applyConfigOption(state: ParseState, text: string): void {
  const match = /^\s*([A-Za-z0-9]+)(?:(?:\s*=\s*|\s+)([\s\S]*))?$/.exec(text);
  if (!match) throw new UsageError(`cannot parse -o option: ${text}`);
  const key = match[1].toLowerCase();
  const value = unquote(match[2] ?? '');
  switch (key) {
    case 'requesttty':
      state.ttyOption ??= parseRequestTty(value);
      break;
    case 'remotecommand':
      if (state.remoteCommand === undefined) {
        state.remoteCommand = value === '' || value.toLowerCase() === 'none' ? null : value;
      }
      break;
    case 'setenv':
      applySetEnv(state, value);
      break;
    case 'sendenv':
      state.sendEnv.push(...splitWords(value));
      break;
    default:
      // BatchMode、StrictHostKeyChecking、ServerAlive*、Control*、ForwardAgent …… 与 vibeterm 无关。
      break;
  }
}

function applyFlag(state: ParseState, flag: string): void {
  switch (flag) {
    case 's':
      state.subsystem = true;
      break;
    case 'T':
      state.ttyFlag = 'no';
      break;
    case 't':
      // 与 ssh 一致：连续两个 -t 才是 force（vibeterm 的 'always'）。
      state.ttyFlag = state.ttyFlag === 'force' ? 'always' : 'force';
      break;
    case 'n':
      state.stdinNone = true;
      break;
    case 'q':
      state.quiet = true;
      break;
    case 'v':
      state.verbose += 1;
      break;
    case 'V':
      state.version = true;
      break;
    case 'G':
      state.printConfig = true;
      break;
    default:
      // 4 6 A a C g K k M X x Y y：与 vibeterm 无关，接受并忽略。
      break;
  }
}

function applyValued(state: ParseState, flag: string, value: string): void {
  if (flag === 'o') applyConfigOption(state, value);
  else if (flag === 'l') state.user = value;
  else if (flag === 'p' && /^\d{1,5}$/.test(value)) state.port = Number(value);
  // B b c E e F I i m P S 等：接受并忽略。
}

function rejectOption(flag: string): never {
  throw new UsageError(`-${flag} is not supported: ${REJECTED[flag]}`);
}

/** 解析一个旗标簇（`-xq`、`-p22`、`-o` 加下一词），返回下一个待处理词的下标。 */
function scanCluster(
  args: readonly string[],
  arg: string,
  next: number,
  state: ParseState
): number {
  if (arg.startsWith('--')) throw new UsageError(`unknown option: ${arg}`);
  for (let at = 1; at < arg.length; at += 1) {
    const flag = arg[at];
    if (flag in REJECTED) rejectOption(flag);
    if (NO_ARG.has(flag)) {
      applyFlag(state, flag);
      continue;
    }
    if (!WITH_ARG.has(flag)) throw new UsageError(`unknown option: -${flag}`);
    const attached = arg.slice(at + 1);
    if (attached !== '') {
      applyValued(state, flag, attached);
      return next;
    }
    if (next >= args.length) throw new UsageError(`option -${flag} requires an argument`);
    applyValued(state, flag, args[next]);
    return next + 1;
  }
  return next;
}

/** 扫描一段连续选项，返回第一个未消费词的下标（`--` 被消费）。 */
function scanOptions(args: readonly string[], start: number, state: ParseState): number {
  let index = start;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      state.optionsEnded = true;
      return index + 1;
    }
    if (arg.length < 2 || !arg.startsWith('-')) return index;
    index = scanCluster(args, arg, index + 1, state);
    if (state.version) return args.length;
  }
  return index;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `ssh://[user@]node[:port][/device]`：路径段（若有）即设备，对应 `<node>/<device>`。 */
function parseSshUrl(text: string): { user: string | null; target: string } {
  const match = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/@]+)(?::(\d+))?(?:\/([^?#]*))?$/.exec(text);
  if (!match) throw new UsageError(`cannot parse ssh:// destination: ${text}`);
  const device = match[4] ? safeDecode(match[4]).replace(/\/+$/, '') : '';
  const host = safeDecode(match[2]);
  return {
    user: match[1] ? safeDecode(match[1]) : null,
    target: device ? `${host}/${device}` : host,
  };
}

type Destination = { user: string | null; target: string };

export function parseDestination(text: string): Destination {
  const parsed = text.startsWith('ssh://')
    ? parseSshUrl(text)
    : (() => {
        const at = text.lastIndexOf('@');
        return {
          user: at > 0 ? text.slice(0, at) : null,
          target: at >= 0 ? text.slice(at + 1) : text,
        };
      })();
  if (parsed.target === '' || parsed.target.startsWith('-')) {
    throw new UsageError(`invalid destination: ${text}`);
  }
  return parsed;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** SendEnv：按模式从本机环境取变量；`-PATTERN` 撤销此前已匹配的项（与 ssh_config 一致）。 */
export function resolveSendEnv(patterns: readonly string[], env: Env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const pattern of patterns) {
    if (pattern.startsWith('-')) {
      const matcher = globToRegExp(pattern.slice(1));
      for (const key of Object.keys(picked)) if (matcher.test(key)) delete picked[key];
      continue;
    }
    const matcher = globToRegExp(pattern);
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && ENV_KEY.test(key) && matcher.test(key)) picked[key] = value;
    }
  }
  return picked;
}

function buildCommand(state: ParseState, words: readonly string[]): ExecCommand {
  const joined = words.join(' ');
  if (state.subsystem) {
    if (joined === '') {
      throw new UsageError('-s requires a subsystem name (only sftp is supported)');
    }
    if (joined !== 'sftp') {
      throw new UsageError(`unsupported subsystem: ${joined} (only sftp is supported)`);
    }
    return { kind: 'subsystem', name: 'sftp' };
  }
  if (joined.trim() !== '') return { kind: 'shell', script: joined };
  if (words.length === 0 && state.remoteCommand) {
    return { kind: 'shell', script: state.remoteCommand };
  }
  return { kind: 'login' };
}

function configDump(state: ParseState, destination: Destination, env: Env): RshParse {
  const user = destination.user ?? state.user ?? env.USER ?? env.LOGNAME ?? 'vibeterm';
  return { kind: 'config', config: { hostname: destination.target, user, port: state.port } };
}

function invocationOf(
  state: ParseState,
  destination: Destination,
  words: readonly string[],
  env: Env
): RshParse {
  return {
    kind: 'run',
    invocation: {
      target: destination.target,
      user: destination.user ?? state.user,
      command: buildCommand(state, words),
      tty: state.ttyFlag ?? state.ttyOption ?? 'auto',
      stdin: state.stdinNone ? 'none' : 'auto',
      quiet: state.quiet,
      verbose: state.verbose,
      env: { ...resolveSendEnv(state.sendEnv, env), ...state.setEnv },
    },
  };
}

export function parseRshArgs(args: readonly string[], env: Env = process.env): RshParse {
  const state = newState();
  let index = scanOptions(args, 0, state);
  if (!state.version && index >= args.length) {
    throw new UsageError('missing destination host');
  }
  const destination = state.version ? null : parseDestination(args[index]);
  if (destination && !state.optionsEnded) index = scanOptions(args, index + 1, state);
  else if (destination) index += 1;
  if (state.version || !destination) return { kind: 'version' };
  if (state.printConfig) return configDump(state, destination, env);
  return invocationOf(state, destination, args.slice(index), env);
}
