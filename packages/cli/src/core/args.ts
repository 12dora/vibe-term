// 轻量参数解析：只支持 `--flag`、`--flag value`、`--flag=value` 与 `--` 终止符。
// 未声明的旗标一律报用法错误——静默忽略会让用户以为自己给的选项生效了。

import { UsageError } from './errors';

export type FlagKind = 'boolean' | 'string' | 'number';
export type FlagSpec = Readonly<Record<string, FlagKind>>;
export type FlagValues = Record<string, string | number | boolean | undefined>;

export interface ParsedArgv {
  flags: FlagValues;
  positionals: string[];
}

export const GLOBAL_FLAGS: FlagSpec = {
  entry: 'string',
  node: 'string',
  json: 'boolean',
  quiet: 'boolean',
  'no-color': 'boolean',
  timeout: 'number',
  ca: 'string',
  insecure: 'boolean',
  help: 'boolean',
};

function requireValue(key: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`--${key} requires a value`);
  return value;
}

function coerce(key: string, kind: FlagKind, raw: string | undefined): string | number | boolean {
  if (kind === 'boolean') {
    if (raw === undefined || raw === 'true') return true;
    if (raw === 'false') return false;
    throw new UsageError(`--${key} does not take a value`);
  }
  const value = requireValue(key, raw);
  if (kind === 'string') return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${key} expects a number, got "${value}"`);
  return parsed;
}

/** 下一个 token 能不能当作本旗标的值：以 `-` 开头的都不能，否则 `--node --json` 会吞掉后一个旗标。 */
function takesNext(next: string | undefined): boolean {
  return next !== undefined && !next.startsWith('-');
}

interface FlagToken {
  key: string;
  kind: FlagKind;
  value: string | undefined;
  /** 取值来自下一个 token（调用方要把它一起跳过 / 一起转交）。 */
  consumedNext: boolean;
}

function readFlagToken(argv: readonly string[], index: number, spec: FlagSpec): FlagToken {
  const body = argv[index].slice(2);
  const eq = body.indexOf('=');
  const key = eq >= 0 ? body.slice(0, eq) : body;
  const kind = spec[key];
  if (!kind) throw new UsageError(`unknown flag: --${key}`);
  if (eq >= 0) return { key, kind, value: body.slice(eq + 1), consumedNext: false };
  if (kind === 'boolean') return { key, kind, value: undefined, consumedNext: false };
  const next = argv[index + 1];
  if (!takesNext(next)) throw new UsageError(`--${key} requires a value`);
  return { key, kind, value: next, consumedNext: true };
}

export function parseArgv(argv: readonly string[], spec: FlagSpec): ParsedArgv {
  const flags: FlagValues = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const flag = readFlagToken(argv, index, spec);
    flags[flag.key] = coerce(flag.key, flag.kind, flag.value);
    if (flag.consumedNext) index += 1;
  }

  return { flags, positionals };
}

/**
 * 把全局旗标从 argv 里摘出来，剩下的原样交给命令组自己解析。
 * `spec` 必须是「全局 + 本命令」的并集：未知旗标在这里就报错，而不是拖到命令内部。
 */
export function splitGlobalFlags(
  argv: readonly string[],
  spec: FlagSpec
): { globals: FlagValues; rest: string[] } {
  const globals: FlagValues = {};
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      rest.push(...argv.slice(index));
      break;
    }
    if (token === '-h') {
      globals.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }
    const flag = readFlagToken(argv, index, spec);
    if (flag.key in GLOBAL_FLAGS) {
      globals[flag.key] = coerce(flag.key, flag.kind, flag.value);
    } else {
      rest.push(token);
      if (flag.consumedNext) rest.push(argv[index + 1]);
    }
    if (flag.consumedNext) index += 1;
  }

  return { globals, rest };
}

export function flagString(flags: FlagValues, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(flags: FlagValues, key: string): boolean {
  return flags[key] === true;
}

export function flagNumber(flags: FlagValues, key: string): number | undefined {
  const value = flags[key];
  return typeof value === 'number' ? value : undefined;
}
