import { describe, expect, test } from 'bun:test';
import { type ExecProc, runChild } from './child';
import { execIo } from './io';
import type { ExecEvent, ExecSink } from './types';

function collectSink(): { events: ExecEvent[]; sink: ExecSink } {
  const events: ExecEvent[] = [];
  return {
    events,
    sink: {
      emit: (event) => {
        events.push(event);
      },
      isOpen: () => true,
    },
  };
}

describe('runChild stdin', () => {
  test('2 MiB stdin to sleep plus timeout does not surface EPIPE', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);
    const proc = execIo.spawn(['/bin/sleep', '30'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const { events, sink } = collectSink();
    try {
      await runChild(proc, {
        stdin: new Uint8Array(2 * 1024 * 1024).fill(0x61),
        timeoutMs: 200,
        sink,
        device: { id: 'local', type: 'local' },
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    expect(unhandled).toEqual([]);
    expect(events.find((e) => e.type === 'exit')).toMatchObject({
      code: null,
      signal: 'SIGTERM',
    });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'exec_timeout' });
    expect(events.some((e) => e.type === 'error' && e.code === 'exec_spawn_failed')).toBe(false);
  });

  test('awaited stdin write that rejects EPIPE is swallowed', async () => {
    let resolveExited: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    const proc: ExecProc = {
      pid: 7,
      stdin: {
        write: () =>
          Promise.reject(Object.assign(new Error('EPIPE: broken pipe'), { code: 'EPIPE' })),
        end: () => {},
      },
      stdout: null,
      stderr: null,
      exited,
      kill() {},
      exitCode: 0,
      signalCode: null,
    };
    const { events, sink } = collectSink();
    const run = runChild(proc, {
      stdin: new Uint8Array(8).fill(1),
      timeoutMs: 5_000,
      sink,
      device: { id: 'local', type: 'local' },
    });
    resolveExited(0);
    await run;
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ code: 0 });
  });
});
