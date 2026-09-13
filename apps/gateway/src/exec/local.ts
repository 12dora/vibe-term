import { type Device, errorMessage } from '@vibeterm/shared';
import { type RunChildOpts, runChild } from './child';
import { mergedServiceEnv } from './env';
import { execIo } from './io';
import type { ExecRequest, ExecSink } from './types';

export async function runLocalExec(
  device: Device,
  req: ExecRequest,
  sink: ExecSink,
  signal?: AbortSignal
): Promise<void> {
  const argv = req.shell ? ['/bin/sh', '-c', req.argv[0] ?? ''] : req.argv;
  const opts: RunChildOpts = {
    stdin: req.stdin,
    timeoutMs: req.timeoutMs,
    signal,
    sink,
    device: { id: device.id, type: 'local' },
    maxBytes: req.maxBytes,
  };
  try {
    const proc = execIo.spawn(argv, {
      cwd: req.cwd,
      env: mergedServiceEnv(req.env),
      stdin: req.stdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await runChild(proc, opts);
  } catch (err) {
    if (!sink.isOpen()) return;
    sink.emit({ type: 'error', code: 'exec_spawn_failed', message: errorMessage(err) });
  }
}
