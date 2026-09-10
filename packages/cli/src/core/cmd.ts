// 命令组共用的子命令分发、确认、JSON body 与打印小工具。

import { readFile } from 'node:fs/promises';
import type { FlagSpec, FlagValues } from './args';
import { flagBool, flagString, parseArgv } from './args';
import type { CliContext } from './context';
import { UsageError } from './errors';
import { isInteractive, promptHidden, promptLine, readAllStdin } from './prompt';

export type SubHandler = (
  ctx: CliContext,
  flags: FlagValues,
  positionals: string[]
) => Promise<unknown>;

export async function runSubs(
  ctx: CliContext,
  argv: string[],
  flagsSpec: FlagSpec,
  handlers: Record<string, SubHandler>,
  usageHint: string
): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(argv, flagsSpec);
  const sub = positionals[0];
  if (!sub) throw new UsageError('missing subcommand', usageHint);
  const handler = handlers[sub];
  if (!handler) {
    throw new UsageError(
      `unknown subcommand: ${sub}`,
      `known: ${Object.keys(handlers).join(', ')}`
    );
  }
  const code = await handler(ctx, flags, positionals.slice(1));
  return typeof code === 'number' ? code : undefined;
}

export function requireArg(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) throw new UsageError(`missing ${name}`);
  return value;
}

export function rejectExtra(positionals: readonly string[], count: number): void {
  if (positionals.length > count) {
    throw new UsageError(`unexpected argument: ${positionals[count]}`);
  }
}

export async function confirmOrYes(flags: FlagValues, action: string): Promise<void> {
  if (flagBool(flags, 'yes')) return;
  if (!isInteractive()) {
    throw new UsageError(`${action} requires confirmation`, 'pass --yes');
  }
  const answer = (await promptLine(`${action}? [y/N] `)).trim();
  if (!/^(y|yes)$/i.test(answer)) throw new UsageError('aborted');
}

export function parseDurationMs(raw: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) {
    throw new UsageError(`invalid duration: ${raw}`, 'use 10m, 30s, 1h, or a millisecond count');
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  if (unit === 'ms') return n;
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60_000;
  return n * 3_600_000;
}

export function parseOnOff(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'off' || value === 'false' || value === '0' || value === 'no') return false;
  throw new UsageError(`expected on|off, got ${raw}`);
}

export function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
  }
}

export async function resolveJsonBody(spec: string | undefined): Promise<unknown | undefined> {
  if (spec === undefined) return undefined;
  const text = spec.startsWith('@') ? await readFile(spec.slice(1), 'utf8') : spec;
  return parseJsonText(text, '--body');
}

export function mergeBody(
  base: Record<string, unknown>,
  extra: unknown | undefined
): Record<string, unknown> {
  if (extra === undefined) return base;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new UsageError('--body must be a JSON object');
  }
  return { ...base, ...(extra as Record<string, unknown>) };
}

export function requireObjectBody(
  value: unknown | undefined,
  hint: string
): Record<string, unknown> {
  if (value === undefined) throw new UsageError('missing --body', hint);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('--body must be a JSON object', hint);
  }
  return value as Record<string, unknown>;
}

export function shortId(id: string, n = 8): string {
  return id.length <= n ? id : id.slice(0, n);
}

export function yn(value: boolean | null | undefined): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '-';
}

export function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function emit(ctx: CliContext, jsonValue: unknown, print: () => void): void {
  if (ctx.globals.json) ctx.out.data(jsonValue);
  else print();
}

export function coerceScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return raw;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value) throw new UsageError(`${label} is empty`);
  return value;
}

async function readTrimmedFile(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
}

export interface SecretFieldSpec {
  flag: string;
  envName?: string;
  required?: boolean;
  prompt?: string;
}

/** `--flag-stdin` > `--flag-file` > env > `--flag`（`@file` 或 argv，argv 会打 stderr 警告）> TTY。 */
export async function readSecretField(
  ctx: CliContext,
  flags: FlagValues,
  spec: SecretFieldSpec
): Promise<string | undefined> {
  if (flagBool(flags, `${spec.flag}-stdin`)) {
    return requireNonEmpty(await readAllStdin(), `--${spec.flag}-stdin`);
  }
  const file = flagString(flags, `${spec.flag}-file`);
  if (file) return requireNonEmpty(await readTrimmedFile(file), `--${spec.flag}-file`);
  const fromEnv = spec.envName ? process.env[spec.envName] : undefined;
  if (fromEnv) return fromEnv;
  const argv = flagString(flags, spec.flag);
  if (argv) {
    if (argv.startsWith('@')) {
      return requireNonEmpty(await readTrimmedFile(argv.slice(1)), `--${spec.flag} @file`);
    }
    const envHint = spec.envName ? `, or ${spec.envName}` : '';
    ctx.out.warn(
      `--${spec.flag} on the command line is visible to other processes; prefer --${spec.flag}-stdin, --${spec.flag}-file${envHint}`
    );
    return argv;
  }
  if (!spec.required) return undefined;
  if (!isInteractive()) {
    const envHint = spec.envName ? `, or ${spec.envName}` : '';
    throw new UsageError(
      `--${spec.flag} is required and stdin is not a terminal`,
      `pass --${spec.flag}-stdin, --${spec.flag}-file${envHint}`
    );
  }
  const value = await promptHidden(spec.prompt ?? `${spec.flag}: `);
  return requireNonEmpty(value, spec.flag);
}
