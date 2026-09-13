import { describe, expect, test } from 'bun:test';
import type { CliContext } from './context';
import { type CliError, NetworkError, NotFoundError, UsageError } from './errors';
import {
  EXEC_STREAM_CLOSED,
  EXEC_TIMEOUT_EXIT,
  ExecStreamClosedError,
  applyExecEvent,
  concatTail,
  createExecCollect,
  emptyExecResult,
  execProcessExit,
  mapExecFailure,
  runExecRequest,
} from './exec-client';

describe('applyExecEvent', () => {
  test('accumulates stdout/stderr and records exit', () => {
    const result = emptyExecResult();
    applyExecEvent(
      result,
      { type: 'start', pid: 12, device: { id: 'd', type: 'local' } },
      null,
      null
    );
    applyExecEvent(
      result,
      { type: 'stdout', base64: Buffer.from('hello').toString('base64') },
      null,
      null
    );
    applyExecEvent(
      result,
      { type: 'stderr', base64: Buffer.from('warn').toString('base64') },
      null,
      null
    );
    const done = applyExecEvent(
      result,
      {
        type: 'exit',
        code: 3,
        signal: null,
        durationMs: 40,
        truncated: { stdout: false, stderr: true },
      },
      null,
      null
    );
    expect(done).toBe('done');
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(3);
    expect(result.truncated.stderr).toBe(true);
    expect(result.reason).toBe('exit');
  });

  test('timeout error keeps waiting for exit and pins reason', () => {
    const result = emptyExecResult();
    expect(
      applyExecEvent(
        result,
        { type: 'error', code: 'exec_timeout', message: 'timed out' },
        null,
        null
      )
    ).toBe('continue');
    applyExecEvent(
      result,
      {
        type: 'exit',
        code: null,
        signal: 'SIGTERM',
        durationMs: 10,
        truncated: { stdout: false, stderr: false },
      },
      null,
      null
    );
    expect(result.reason).toBe('timeout');
    expect(execProcessExit(result)).toBe(EXEC_TIMEOUT_EXIT);
  });

  test('streams live bytes and NDJSON when asked', () => {
    const result = emptyExecResult();
    const stdout: string[] = [];
    const events: unknown[] = [];
    applyExecEvent(
      result,
      { type: 'stdout', base64: Buffer.from('x').toString('base64') },
      { stdout: (bytes) => stdout.push(Buffer.from(bytes).toString()), stderr: () => undefined },
      (event) => events.push(event)
    );
    expect(stdout).toEqual(['x']);
    expect(events).toHaveLength(1);
  });

  test('ignores ping and other unknown events', () => {
    const result = emptyExecResult();
    expect(applyExecEvent(result, { type: 'ping', t: 12 }, null, null)).toBe('continue');
    expect(applyExecEvent(result, { type: 'start', pid: 1 }, null, null)).toBe('continue');
    expect(result.stdout).toBe('');
    expect(result.reason).toBe('error');
  });

  test('exit.reason exec_timeout pins CLI reason without waiting for error', () => {
    const result = emptyExecResult();
    applyExecEvent(
      result,
      {
        type: 'exit',
        code: null,
        signal: 'SIGTERM',
        durationMs: 9,
        truncated: { stdout: false, stderr: false },
        reason: 'exec_timeout',
      },
      null,
      null
    );
    expect(result.reason).toBe('timeout');
    expect(execProcessExit(result)).toBe(EXEC_TIMEOUT_EXIT);
  });

  test('tail collect keeps the last N bytes and marks truncated', () => {
    const result = emptyExecResult();
    const collect = createExecCollect({ tailBytes: 4 });
    applyExecEvent(
      result,
      { type: 'stdout', base64: Buffer.from('hello world').toString('base64') },
      null,
      null,
      collect
    );
    expect(result.stdout).toBe('orld');
    expect(result.stdoutBytes).toBe(11);
    expect(result.truncated.stdout).toBe(true);
  });

  test('omitStdout skips inline strings but still counts bytes', () => {
    const result = emptyExecResult();
    const collect = createExecCollect({ omitStdout: true });
    applyExecEvent(
      result,
      { type: 'stdout', base64: Buffer.from('payload').toString('base64') },
      null,
      null,
      collect
    );
    expect(result.stdout).toBe('');
    expect(result.stdoutBytes).toBe(7);
  });
});

describe('concatTail', () => {
  test('keeps the last limit bytes across chunks', () => {
    const first = concatTail(new Uint8Array(), Buffer.from('abcd'), 3);
    expect(Buffer.from(first.bytes).toString()).toBe('bcd');
    expect(first.dropped).toBe(true);
    const second = concatTail(first.bytes, Buffer.from('ef'), 3);
    expect(Buffer.from(second.bytes).toString()).toBe('def');
    expect(second.dropped).toBe(true);
  });
});

describe('mapExecFailure', () => {
  test('maps validation and missing-device codes', () => {
    expect(() => mapExecFailure('invalid_body', 'bad')).toThrow(UsageError);
    expect(() => mapExecFailure('device_not_found', 'gone')).toThrow(NotFoundError);
    expect(() => mapExecFailure('exec_spawn_failed', 'boom')).toThrow(NetworkError);
  });

  test('other and missing codes are exit 5', () => {
    const other = (() => {
      try {
        mapExecFailure('exec_unsupported_device', 'nope');
      } catch (error) {
        return error as CliError;
      }
      return null;
    })();
    expect(other).toBeInstanceOf(NetworkError);
    expect(other?.exitCode).toBe(5);
    const bare = (() => {
      try {
        mapExecFailure(null, 'plain 400');
      } catch (error) {
        return error as CliError;
      }
      return null;
    })();
    expect(bare?.exitCode).toBe(5);
  });
});

function ctxWithNdjson(gen: () => AsyncGenerator<unknown>): CliContext {
  return {
    http: {
      ndjson: () => gen(),
    },
  } as unknown as CliContext;
}

const BODY = { deviceId: 'd', argv: ['true'] };

describe('runExecRequest stream death', () => {
  test('terminated TypeError becomes EXEC_STREAM_CLOSED', async () => {
    const ctx = ctxWithNdjson(async function* () {
      yield { type: 'start', pid: 1, device: { id: 'd', type: 'local' } };
      throw new TypeError('terminated');
    });
    const error = await runExecRequest(ctx, 'self', BODY).catch((err) => err);
    expect(error).toBeInstanceOf(ExecStreamClosedError);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as ExecStreamClosedError).code).toBe(EXEC_STREAM_CLOSED);
    expect((error as ExecStreamClosedError).reason).toBe('terminated');
    expect((error as ExecStreamClosedError).message).toContain('the remote child receives SIGTERM');
    expect((error as ExecStreamClosedError).elapsedMs).toBeGreaterThanOrEqual(0);
    expect((error as ExecStreamClosedError).exitCode).toBe(5);
  });

  test('clean end without exit is EXEC_STREAM_CLOSED', async () => {
    const ctx = ctxWithNdjson(async function* () {
      yield { type: 'start', pid: 1, device: { id: 'd', type: 'local' } };
    });
    const error = await runExecRequest(ctx, 'self', BODY).catch((err) => err);
    expect(error).toBeInstanceOf(ExecStreamClosedError);
    expect((error as ExecStreamClosedError).reason).toBe('ended without an exit event');
  });

  test('--json --stream forwards ping as-is', async () => {
    const forwarded: unknown[] = [];
    const ctx = ctxWithNdjson(async function* () {
      yield { type: 'ping', t: 99 };
      yield {
        type: 'exit',
        code: 0,
        signal: null,
        durationMs: 1,
        truncated: { stdout: false, stderr: false },
        reason: 'exit',
      };
    });
    const result = await runExecRequest(ctx, 'self', BODY, {
      streamJson: (event) => forwarded.push(event),
    });
    expect(forwarded[0]).toEqual({ type: 'ping', t: 99 });
    expect(result.exitCode).toBe(0);
  });
});
