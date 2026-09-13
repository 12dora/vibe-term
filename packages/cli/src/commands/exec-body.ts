// exec 请求体：stdin / --script、序列化后的 1 MiB 上限。

import { readFile } from 'node:fs/promises';
import { type FlagValues, flagBool, flagString, flagStrings } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import {
  EXEC_JSON_BODY_BUDGET,
  type ExecRequestBody,
  MAX_EXEC_STDIN_BYTES,
  MAX_EXEC_TIMEOUT_MS,
} from '../core/exec-client';
import { readAllStdin } from '../core/prompt';

const SCRIPT_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

export function parseEnvPairs(pairs: string[]): Record<string, string> {
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

export function assertSerializedExecBody(body: ExecRequestBody): void {
  const encoded = Buffer.byteLength(JSON.stringify(body));
  if (encoded <= EXEC_JSON_BODY_BUDGET) return;
  throw new UsageError(
    `request body is ${encoded} bytes (server cap 1 MiB); copy the file with vibeterm cp and read it on the device`
  );
}

export interface ExecBodyArgs {
  flags: FlagValues;
  commandArgv: string[];
  atFile: string | null;
  maxBytes: number | undefined;
}

export async function buildExecBody(
  ctx: CliContext,
  deviceId: string,
  parsed: ExecBodyArgs
): Promise<{ body: ExecRequestBody; scriptFallback: string | null }> {
  const script = flagString(parsed.flags, 'script');
  const envPairs = parseEnvPairs(flagStrings(parsed.flags, 'env'));
  const cwd = flagString(parsed.flags, 'cwd');
  const timeoutMs = execTimeoutMs(ctx);
  const extras: Pick<ExecRequestBody, 'timeoutMs' | 'cwd' | 'env' | 'maxBytes'> = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(envPairs).length > 0 ? { env: envPairs } : {}),
    ...(parsed.maxBytes === undefined ? {} : { maxBytes: parsed.maxBytes }),
  };
  let built: { body: ExecRequestBody; scriptFallback: string | null };
  if (script) {
    const loaded = await readScriptBody(script, flagString(parsed.flags, 'interpreter'));
    built = {
      scriptFallback: loaded.fallback,
      body: {
        deviceId,
        argv: loaded.argv,
        stdin: stdinField(loaded.stdin),
        ...extras,
      },
    };
  } else {
    const stdinBytes = await readStdinBytes(parsed.flags, parsed.atFile);
    built = {
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
  assertSerializedExecBody(built.body);
  return built;
}
