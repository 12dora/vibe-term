import {
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  EXEC_MIN_MAX_BYTES,
  EXEC_STREAM_CAP_BYTES,
} from './constants';
import type { ExecRequest } from './types';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ParseExecResult =
  | { ok: true; value: ExecRequest }
  | { ok: false; code: 'invalid_body'; message: string };

export function parseExecRequest(body: Record<string, unknown>): ParseExecResult {
  const deviceId = parseDeviceId(body.deviceId);
  if (!deviceId.ok) return deviceId;
  const argv = parseArgv(body.argv, body.shell === true);
  if (!argv.ok) return argv;
  const timeoutMs = parseTimeoutMs(body.timeoutMs);
  if (!timeoutMs.ok) return timeoutMs;
  const cwd = parseOptionalString(body.cwd, 'cwd');
  if (!cwd.ok) return cwd;
  const env = parseEnv(body.env);
  if (!env.ok) return env;
  const stdin = parseStdin(body.stdin);
  if (!stdin.ok) return stdin;
  const maxBytes = parseMaxBytes(body.maxBytes);
  if (!maxBytes.ok) return maxBytes;
  return {
    ok: true,
    value: {
      deviceId: deviceId.value,
      argv: argv.value,
      timeoutMs: timeoutMs.value,
      maxBytes: maxBytes.value,
      shell: body.shell === true,
      ...(cwd.value !== undefined ? { cwd: cwd.value } : {}),
      ...(env.value !== undefined ? { env: env.value } : {}),
      ...(stdin.value !== undefined ? { stdin: stdin.value } : {}),
    },
  };
}

function fail(message: string): { ok: false; code: 'invalid_body'; message: string } {
  return { ok: false, code: 'invalid_body', message };
}

function parseDeviceId(
  raw: unknown
): { ok: true; value: string } | { ok: false; code: 'invalid_body'; message: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail('deviceId must be a non-empty string');
  }
  return { ok: true, value: raw };
}

function parseArgv(
  raw: unknown,
  shell: boolean
): { ok: true; value: string[] } | { ok: false; code: 'invalid_body'; message: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string')) {
    return fail('argv must be a non-empty string array');
  }
  if (shell && raw.length !== 1) {
    return fail('shell:true requires argv to have exactly one element');
  }
  return { ok: true, value: raw };
}

function parseTimeoutMs(
  raw: unknown
): { ok: true; value: number } | { ok: false; code: 'invalid_body'; message: string } {
  if (raw === undefined) return { ok: true, value: EXEC_DEFAULT_TIMEOUT_MS };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fail('timeoutMs must be a finite number');
  }
  const n = Math.trunc(raw);
  if (n < 1 || n > EXEC_MAX_TIMEOUT_MS) {
    return fail(`timeoutMs must be between 1 and ${EXEC_MAX_TIMEOUT_MS}`);
  }
  return { ok: true, value: n };
}

function parseMaxBytes(
  raw: unknown
): { ok: true; value: number } | { ok: false; code: 'invalid_body'; message: string } {
  if (raw === undefined) return { ok: true, value: EXEC_STREAM_CAP_BYTES };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fail('maxBytes must be a finite number');
  }
  const n = Math.trunc(raw);
  if (n < EXEC_MIN_MAX_BYTES || n > EXEC_STREAM_CAP_BYTES) {
    return fail(`maxBytes must be between ${EXEC_MIN_MAX_BYTES} and ${EXEC_STREAM_CAP_BYTES}`);
  }
  return { ok: true, value: n };
}

function parseOptionalString(
  raw: unknown,
  field: string
): { ok: true; value: string | undefined } | { ok: false; code: 'invalid_body'; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(`${field} must be a non-empty string`);
  }
  return { ok: true, value: raw };
}

function parseEnv(
  raw: unknown
):
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; code: 'invalid_body'; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('env must be an object of string values');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY.test(key) || typeof value !== 'string') {
      return fail('env keys must be identifiers and values must be strings');
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

function parseStdin(
  raw: unknown
):
  | { ok: true; value: Uint8Array | undefined }
  | { ok: false; code: 'invalid_body'; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('stdin must be { text } or { base64 }');
  }
  const rec = raw as { text?: unknown; base64?: unknown };
  const hasText = rec.text !== undefined;
  const hasB64 = rec.base64 !== undefined;
  if (hasText === hasB64) return fail('stdin must be { text } or { base64 }');
  if (hasText) {
    if (typeof rec.text !== 'string') return fail('stdin.text must be a string');
    return { ok: true, value: new TextEncoder().encode(rec.text) };
  }
  if (typeof rec.base64 !== 'string') return fail('stdin.base64 must be a string');
  return { ok: true, value: Buffer.from(rec.base64, 'base64') };
}
