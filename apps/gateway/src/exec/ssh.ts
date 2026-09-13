import { type Device, errorMessage } from '@vibeterm/shared';
import type { OpenSshTarget } from '../files/ssh-target';
import { type RunChildOpts, runChild } from './child';
import { mergedServiceEnv } from './env';
import { execIo } from './io';
import { buildSshRemoteCommand } from './remote-command';
import type { ExecRequest, ExecSink } from './types';

export async function runSshExec(
  device: Device,
  req: ExecRequest,
  sink: ExecSink,
  signal?: AbortSignal
): Promise<void> {
  const resolved = await execIo.resolveSsh(device, execIo.decrypt, execIo.resolveSshConfig);
  if (!resolved.ok) {
    emitResolveError(sink, resolved.code, resolved.message);
    return;
  }
  if (resolved.target.interactive) {
    resolved.target.cleanup();
    emitUnsupported(sink);
    return;
  }
  await spawnSsh(device, req, sink, signal, resolved.target);
}

function emitUnsupported(sink: ExecSink): void {
  if (!sink.isOpen()) return;
  sink.emit({
    type: 'error',
    code: 'exec_unsupported_device',
    message: 'password-auth SSH devices are not supported',
  });
}

function emitResolveError(sink: ExecSink, code: string, message: string): void {
  if (!sink.isOpen()) return;
  sink.emit({
    type: 'error',
    code: code === 'auth_unsupported' ? 'exec_unsupported_device' : 'exec_spawn_failed',
    message,
  });
}

async function spawnSsh(
  device: Device,
  req: ExecRequest,
  sink: ExecSink,
  signal: AbortSignal | undefined,
  target: OpenSshTarget
): Promise<void> {
  const opts: RunChildOpts = {
    stdin: req.stdin,
    timeoutMs: req.timeoutMs,
    signal,
    sink,
    device: { id: device.id, type: 'ssh' },
  };
  const argv = [...target.sshArgs, '-T', target.dest, '--', buildSshRemoteCommand(req)];
  try {
    const proc = execIo.spawn(argv, {
      env: mergedServiceEnv(target.env),
      stdin: req.stdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await runChild(proc, opts);
  } catch (err) {
    if (sink.isOpen()) {
      sink.emit({ type: 'error', code: 'exec_spawn_failed', message: errorMessage(err) });
    }
  } finally {
    target.cleanup();
  }
}
