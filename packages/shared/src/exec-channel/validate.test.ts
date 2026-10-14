import { describe, expect, it } from 'bun:test';
import {
  EC_DEFAULT_DETACH_GRACE_MS,
  EC_MAX_DETACH_GRACE_MS,
  EC_MAX_TIMEOUT_MS,
  validateHello,
  validateOpenSpec,
} from './index';

const base = { command: { kind: 'shell', script: 'echo hi' }, stdin: false };

function accepted(raw: unknown) {
  const result = validateOpenSpec(raw);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.message}`);
  return result.spec;
}

function rejected(raw: unknown): string {
  const result = validateOpenSpec(raw);
  if (result.ok) throw new Error('expected rejection');
  return result.message;
}

describe('validateOpenSpec defaults', () => {
  it('fills defaults for a minimal spec', () => {
    expect(accepted(base)).toEqual({
      command: { kind: 'shell', script: 'echo hi', sh: false },
      env: {},
      pty: null,
      stdin: false,
      timeoutMs: 0,
      detachGraceMs: EC_DEFAULT_DETACH_GRACE_MS,
    });
  });

  it('treats a missing stdin as false', () => {
    expect(accepted({ command: { kind: 'login' } }).stdin).toBe(false);
  });

  it('keeps optional device and cwd only when present', () => {
    const spec = accepted({ ...base, device: 'build-box', cwd: '/srv/app' });
    expect(spec.device).toBe('build-box');
    expect(spec.cwd).toBe('/srv/app');
    const bare = accepted({ ...base, device: null, cwd: null });
    expect('device' in bare).toBe(false);
    expect('cwd' in bare).toBe(false);
  });

  it('defaults the pty terminal and keeps explicit values', () => {
    expect(accepted({ ...base, pty: { cols: 80, rows: 24 } }).pty).toEqual({
      cols: 80,
      rows: 24,
      term: 'xterm-256color',
    });
    expect(accepted({ ...base, pty: { cols: 1, rows: 1000, term: 'vt100' } }).pty).toEqual({
      cols: 1,
      rows: 1000,
      term: 'vt100',
    });
    expect(accepted({ ...base, pty: null }).pty).toBeNull();
  });

  it('accepts boundary values for timeout and grace', () => {
    const spec = accepted({
      ...base,
      timeoutMs: EC_MAX_TIMEOUT_MS,
      detachGraceMs: EC_MAX_DETACH_GRACE_MS,
    });
    expect(spec.timeoutMs).toBe(EC_MAX_TIMEOUT_MS);
    expect(spec.detachGraceMs).toBe(EC_MAX_DETACH_GRACE_MS);
    expect(accepted({ ...base, detachGraceMs: 0 }).detachGraceMs).toBe(0);
  });

  it('does not leak unknown fields or alias the input', () => {
    const argv = ['ls', '-l'];
    const spec = accepted({ ...base, command: { kind: 'argv', argv, extra: 1 }, bogus: true });
    expect(spec.command).toEqual({ kind: 'argv', argv: ['ls', '-l'] });
    expect((spec.command as { argv: string[] }).argv).not.toBe(argv);
    expect('bogus' in spec).toBe(false);
  });
});

describe('validateOpenSpec commands', () => {
  it('accepts every command kind', () => {
    const shell = { kind: 'shell', script: 'x', sh: true };
    expect(accepted({ ...base, command: shell }).command).toEqual(shell);
    expect(accepted({ ...base, command: { kind: 'login' } }).command).toEqual({ kind: 'login' });
    expect(accepted({ ...base, command: { kind: 'subsystem', name: 'sftp' } }).command).toEqual({
      kind: 'subsystem',
      name: 'sftp',
    });
  });

  it('rejects malformed commands', () => {
    expect(rejected({ stdin: false })).toContain('command');
    expect(rejected({ ...base, command: 'ls' })).toContain('command');
    expect(rejected({ ...base, command: { kind: 'exec' } })).toContain('command.kind');
    expect(rejected({ ...base, command: { kind: 'shell' } })).toContain('script');
    expect(rejected({ ...base, command: { kind: 'shell', script: '' } })).toContain('script');
    expect(rejected({ ...base, command: { kind: 'shell', script: 'a\0b' } })).toContain('script');
    expect(rejected({ ...base, command: { kind: 'shell', script: 'x', sh: 1 } })).toContain('sh');
    expect(rejected({ ...base, command: { kind: 'argv', argv: [] } })).toContain('argv');
    expect(rejected({ ...base, command: { kind: 'argv', argv: [''] } })).toContain('argv[0]');
    expect(rejected({ ...base, command: { kind: 'argv', argv: ['ls', 1] } })).toContain('argv');
    expect(rejected({ ...base, command: { kind: 'argv', argv: ['a\0'] } })).toContain('argv');
    expect(rejected({ ...base, command: { kind: 'subsystem', name: 'shell' } })).toContain(
      'subsystem'
    );
  });
});

describe('validateOpenSpec rejections', () => {
  it('rejects non-object specs', () => {
    for (const raw of [null, undefined, 'x', 1, []]) expect(rejected(raw)).toContain('spec');
  });

  it('rejects a non-boolean stdin', () => {
    expect(rejected({ ...base, stdin: 'yes' })).toContain('stdin');
    expect(rejected({ ...base, stdin: 1 })).toContain('stdin');
  });

  it('rejects bad device and cwd', () => {
    expect(rejected({ ...base, device: '' })).toContain('device');
    expect(rejected({ ...base, device: 5 })).toContain('device');
    expect(rejected({ ...base, device: 'a'.repeat(257) })).toContain('device');
    expect(rejected({ ...base, cwd: '' })).toContain('cwd');
    expect(rejected({ ...base, cwd: '/a\0b' })).toContain('cwd');
    expect(rejected({ ...base, cwd: '/'.repeat(4097) })).toContain('cwd');
  });

  it('rejects bad env', () => {
    expect(rejected({ ...base, env: [] })).toContain('env');
    expect(rejected({ ...base, env: 'A=1' })).toContain('env');
    expect(rejected({ ...base, env: { '1BAD': 'x' } })).toContain('1BAD');
    expect(rejected({ ...base, env: { 'A-B': 'x' } })).toContain('A-B');
    expect(rejected({ ...base, env: { A: 1 } })).toContain('A');
    expect(rejected({ ...base, env: { A: 'x\0' } })).toContain('A');
    expect(rejected({ ...base, env: { A: 'x'.repeat(32 * 1024 + 1) } })).toContain('A');
    const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`K${i}`, 'v']));
    expect(rejected({ ...base, env: tooMany })).toContain('env');
  });

  it('accepts valid env names', () => {
    expect(accepted({ ...base, env: { _a1: 'x', LANG: '' } }).env).toEqual({ _a1: 'x', LANG: '' });
  });

  it('rejects bad pty', () => {
    expect(rejected({ ...base, pty: 'xterm' })).toContain('pty');
    expect(rejected({ ...base, pty: { rows: 24 } })).toContain('pty');
    expect(rejected({ ...base, pty: { cols: 0, rows: 24 } })).toContain('pty');
    expect(rejected({ ...base, pty: { cols: 80, rows: 1001 } })).toContain('pty');
    expect(rejected({ ...base, pty: { cols: 80.5, rows: 24 } })).toContain('pty');
    expect(rejected({ ...base, pty: { cols: '80', rows: 24 } })).toContain('pty');
    expect(rejected({ ...base, pty: { cols: 80, rows: 24, term: 'a b' } })).toContain('term');
    expect(rejected({ ...base, pty: { cols: 80, rows: 24, term: 7 } })).toContain('term');
  });

  it('rejects out-of-range timeout and grace', () => {
    expect(rejected({ ...base, timeoutMs: -1 })).toContain('timeoutMs');
    expect(rejected({ ...base, timeoutMs: EC_MAX_TIMEOUT_MS + 1 })).toContain('timeoutMs');
    expect(rejected({ ...base, timeoutMs: 1.5 })).toContain('timeoutMs');
    expect(rejected({ ...base, timeoutMs: '5' })).toContain('timeoutMs');
    expect(rejected({ ...base, detachGraceMs: -1 })).toContain('detachGraceMs');
    expect(rejected({ ...base, detachGraceMs: EC_MAX_DETACH_GRACE_MS + 1 })).toContain(
      'detachGraceMs'
    );
    expect(rejected({ ...base, detachGraceMs: Number.NaN })).toContain('detachGraceMs');
  });
});

describe('validateHello', () => {
  const sessionId = 'a'.repeat(32);

  it('validates and defaults an open hello', () => {
    const result = validateHello({ v: 1, op: 'open', spec: base });
    expect(result.ok).toBe(true);
    if (result.ok && result.hello.op === 'open') {
      expect(result.hello.spec.detachGraceMs).toBe(EC_DEFAULT_DETACH_GRACE_MS);
    }
  });

  it('propagates spec errors', () => {
    const result = validateHello({ v: 1, op: 'open', spec: { ...base, stdin: 'x' } });
    expect(result.ok).toBe(false);
    expect(validateHello({ v: 1, op: 'open' }).ok).toBe(false);
  });

  it('accepts a resume hello', () => {
    expect(validateHello({ v: 1, op: 'resume', sessionId, out: 0 })).toEqual({
      ok: true,
      hello: { v: 1, op: 'resume', sessionId, out: 0 },
    });
    expect(validateHello({ v: 1, op: 'resume', sessionId, out: 2 ** 40 }).ok).toBe(true);
  });

  it('rejects malformed resume hellos', () => {
    for (const bad of [
      'A'.repeat(32),
      'a'.repeat(31),
      'a'.repeat(33),
      `${'a'.repeat(31)}g`,
      '',
      5,
      undefined,
    ]) {
      expect(validateHello({ v: 1, op: 'resume', sessionId: bad, out: 0 }).ok).toBe(false);
    }
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53, '3', null, undefined]) {
      expect(validateHello({ v: 1, op: 'resume', sessionId, out: bad }).ok).toBe(false);
    }
  });

  it('rejects bad envelopes', () => {
    for (const raw of [null, 'x', [], {}, { v: 2, op: 'open', spec: base }, { v: 1, op: 'peek' }]) {
      expect(validateHello(raw).ok).toBe(false);
    }
  });
});
