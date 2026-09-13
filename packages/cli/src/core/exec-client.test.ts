import { describe, expect, test } from 'bun:test';
import { type CliError, NetworkError, NotFoundError, UsageError } from './errors';
import {
  EXEC_TIMEOUT_EXIT,
  applyExecEvent,
  emptyExecResult,
  execProcessExit,
  mapExecFailure,
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
