import {
  EC_DEFAULT_DETACH_GRACE_MS,
  EC_DEFAULT_TERM,
  EC_MAX_DETACH_GRACE_MS,
  EC_MAX_PTY_DIMENSION,
  EC_MAX_TIMEOUT_MS,
} from './constants';
import type {
  ExecCommand,
  ResolvedExecOpenSpec,
  ValidateHelloResult,
  ValidateOpenSpecResult,
} from './types';

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_ID = /^[0-9a-f]{32}$/;
const TERM_NAME = /^[A-Za-z0-9._+-]{1,64}$/;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_CHARS = 32 * 1024;
const MAX_PATH_CHARS = 4096;
const MAX_DEVICE_CHARS = 256;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (message: string): Parsed<never> => ({ ok: false, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isDimension(value: unknown): value is number {
  return isIntInRange(value, 1, EC_MAX_PTY_DIMENSION);
}

function parseOptionalString(
  value: unknown,
  field: string,
  maxChars: number
): Parsed<string | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || hasNul(value)) {
    return fail(`${field} must be a non-empty string up to ${maxChars} characters`);
  }
  return ok(value);
}

function parseShell(raw: Record<string, unknown>): Parsed<ExecCommand> {
  const { script, sh } = raw;
  if (typeof script !== 'string' || script.length === 0 || hasNul(script)) {
    return fail('command.script must be a non-empty string');
  }
  if (sh !== undefined && typeof sh !== 'boolean') return fail('command.sh must be a boolean');
  return ok({ kind: 'shell', script, sh: sh === true });
}

function parseArgv(raw: Record<string, unknown>): Parsed<ExecCommand> {
  const { argv } = raw;
  if (!Array.isArray(argv) || argv.length === 0) {
    return fail('command.argv must be a non-empty array');
  }
  for (const item of argv) {
    if (typeof item !== 'string' || hasNul(item)) return fail('command.argv must contain strings');
  }
  if (argv[0] === '') return fail('command.argv[0] must not be empty');
  return ok({ kind: 'argv', argv: [...argv] as string[] });
}

function parseCommand(raw: unknown): Parsed<ExecCommand> {
  if (!isRecord(raw)) return fail('command is required');
  switch (raw.kind) {
    case 'shell':
      return parseShell(raw);
    case 'argv':
      return parseArgv(raw);
    case 'login':
      return ok({ kind: 'login' });
    case 'subsystem':
      return raw.name === 'sftp'
        ? ok({ kind: 'subsystem', name: 'sftp' })
        : fail('unsupported subsystem');
    default:
      return fail('unsupported command.kind');
  }
}

function parseEnv(raw: unknown): Parsed<Record<string, string>> {
  if (raw === undefined || raw === null) return ok({});
  if (!isRecord(raw)) return fail('env must be an object');
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV_ENTRIES) {
    return fail(`env supports at most ${MAX_ENV_ENTRIES} entries`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) return fail(`invalid env name: ${key}`);
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_CHARS || hasNul(value)) {
      return fail(`invalid env value for ${key}`);
    }
    env[key] = value;
  }
  return ok(env);
}

function parsePty(raw: unknown): Parsed<ResolvedExecOpenSpec['pty']> {
  if (raw === undefined || raw === null) return ok(null);
  if (!isRecord(raw)) return fail('pty must be an object or null');
  const { cols, rows, term } = raw;
  if (!isDimension(cols) || !isDimension(rows)) {
    return fail(`pty.cols and pty.rows must be integers in 1..${EC_MAX_PTY_DIMENSION}`);
  }
  if (term === undefined || term === null) return ok({ cols, rows, term: EC_DEFAULT_TERM });
  if (typeof term !== 'string' || !TERM_NAME.test(term)) return fail('pty.term is invalid');
  return ok({ cols, rows, term });
}

function parseRange(value: unknown, field: string, fallback: number, max: number): Parsed<number> {
  if (value === undefined || value === null) return ok(fallback);
  if (!isIntInRange(value, 0, max)) return fail(`${field} must be an integer in 0..${max}`);
  return ok(value);
}

function unwrap<T>(result: Parsed<T>): T {
  if (!result.ok) throw new SpecRejection(result.message);
  return result.value;
}

class SpecRejection extends Error {}

function buildSpec(raw: Record<string, unknown>): ResolvedExecOpenSpec {
  if (raw.stdin !== undefined && typeof raw.stdin !== 'boolean') {
    throw new SpecRejection('stdin must be a boolean');
  }
  const device = unwrap(parseOptionalString(raw.device, 'device', MAX_DEVICE_CHARS));
  const cwd = unwrap(parseOptionalString(raw.cwd, 'cwd', MAX_PATH_CHARS));
  const spec: ResolvedExecOpenSpec = {
    command: unwrap(parseCommand(raw.command)),
    env: unwrap(parseEnv(raw.env)),
    pty: unwrap(parsePty(raw.pty)),
    stdin: raw.stdin === true,
    timeoutMs: unwrap(parseRange(raw.timeoutMs, 'timeoutMs', 0, EC_MAX_TIMEOUT_MS)),
    detachGraceMs: unwrap(
      parseRange(
        raw.detachGraceMs,
        'detachGraceMs',
        EC_DEFAULT_DETACH_GRACE_MS,
        EC_MAX_DETACH_GRACE_MS
      )
    ),
  };
  if (device !== undefined) spec.device = device;
  if (cwd !== undefined) spec.cwd = cwd;
  return spec;
}

export function validateOpenSpec(raw: unknown): ValidateOpenSpecResult {
  if (!isRecord(raw)) return { ok: false, message: 'spec must be an object' };
  try {
    return { ok: true, spec: buildSpec(raw) };
  } catch (error) {
    if (error instanceof SpecRejection) return { ok: false, message: error.message };
    throw error;
  }
}

export function validateHello(raw: unknown): ValidateHelloResult {
  if (!isRecord(raw)) return { ok: false, message: 'hello must be an object' };
  if (raw.v !== 1) return { ok: false, message: 'unsupported protocol version' };
  if (raw.op === 'open') {
    const result = validateOpenSpec(raw.spec);
    return result.ok ? { ok: true, hello: { v: 1, op: 'open', spec: result.spec } } : result;
  }
  if (raw.op === 'resume') return validateResume(raw);
  return { ok: false, message: 'unsupported hello op' };
}

function validateResume(raw: Record<string, unknown>): ValidateHelloResult {
  const { sessionId, out } = raw;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { ok: false, message: 'sessionId must be 32 lowercase hex characters' };
  }
  if (typeof out !== 'number' || !Number.isSafeInteger(out) || out < 0) {
    return { ok: false, message: 'out must be a non-negative integer' };
  }
  return { ok: true, hello: { v: 1, op: 'resume', sessionId, out } };
}
