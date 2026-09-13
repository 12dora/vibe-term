import { describe, expect, test } from 'bun:test';
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  EXEC_MIN_MAX_BYTES,
  EXEC_STREAM_CAP_BYTES,
} from './constants';
import { parseExecRequest } from './parse';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { deviceId: 'd1', argv: ['/bin/echo', 'ok'], ...overrides };
}

describe('parseExecRequest', () => {
  test('accepts a minimal body and fills timeout/shell defaults', () => {
    const parsed = parseExecRequest(body());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      deviceId: 'd1',
      argv: ['/bin/echo', 'ok'],
      timeoutMs: EXEC_DEFAULT_TIMEOUT_MS,
      maxBytes: EXEC_STREAM_CAP_BYTES,
      shell: false,
    });
  });

  test('decodes stdin text and base64', () => {
    const text = parseExecRequest(body({ stdin: { text: 'hi' } }));
    expect(text.ok).toBe(true);
    if (text.ok) expect(Buffer.from(text.value.stdin ?? []).toString()).toBe('hi');
    const b64 = parseExecRequest(body({ stdin: { base64: Buffer.from('yo').toString('base64') } }));
    expect(b64.ok).toBe(true);
    if (b64.ok) expect(Buffer.from(b64.value.stdin ?? []).toString()).toBe('yo');
  });

  test('rejects invalid argv, shell arity, timeout, env, stdin, and deviceId', () => {
    expect(parseExecRequest(body({ deviceId: '' })).ok).toBe(false);
    expect(parseExecRequest(body({ argv: [] })).ok).toBe(false);
    expect(parseExecRequest(body({ argv: [1] })).ok).toBe(false);
    expect(parseExecRequest(body({ shell: true, argv: ['a', 'b'] })).ok).toBe(false);
    expect(parseExecRequest(body({ timeoutMs: 0 })).ok).toBe(false);
    expect(parseExecRequest(body({ timeoutMs: EXEC_MAX_TIMEOUT_MS + 1 })).ok).toBe(false);
    expect(parseExecRequest(body({ timeoutMs: 'fast' })).ok).toBe(false);
    expect(parseExecRequest(body({ cwd: '' })).ok).toBe(false);
    expect(parseExecRequest(body({ env: { '1BAD': 'x' } })).ok).toBe(false);
    expect(parseExecRequest(body({ env: { FOO: 1 } })).ok).toBe(false);
    expect(parseExecRequest(body({ stdin: {} })).ok).toBe(false);
    expect(parseExecRequest(body({ stdin: { text: 'a', base64: 'YQ==' } })).ok).toBe(false);
    expect(parseExecRequest(body({ maxBytes: EXEC_MIN_MAX_BYTES - 1 })).ok).toBe(false);
    expect(parseExecRequest(body({ maxBytes: EXEC_STREAM_CAP_BYTES + 1 })).ok).toBe(false);
    expect(parseExecRequest(body({ maxBytes: 'big' })).ok).toBe(false);
  });

  test('accepts maxBytes in 1 KiB .. 8 MiB and truncates fractions', () => {
    const parsed = parseExecRequest(body({ maxBytes: 2048.9 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.maxBytes).toBe(2048);
    const min = parseExecRequest(body({ maxBytes: EXEC_MIN_MAX_BYTES }));
    expect(min.ok).toBe(true);
    if (min.ok) expect(min.value.maxBytes).toBe(EXEC_MIN_MAX_BYTES);
  });

  test('truncates a fractional timeoutMs', () => {
    const parsed = parseExecRequest(body({ timeoutMs: 1500.9 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.timeoutMs).toBe(1500);
  });
});
