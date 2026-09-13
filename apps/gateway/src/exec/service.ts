import type { Device } from '@vibeterm/shared';
import { runLocalExec } from './local';
import { runSshExec } from './ssh';
import type { ExecRequest, ExecSink } from './types';

export async function runExec(
  device: Device,
  req: ExecRequest,
  sink: ExecSink,
  signal?: AbortSignal
): Promise<void> {
  if (device.type === 'local') {
    await runLocalExec(device, req, sink, signal);
    return;
  }
  if (device.type === 'ssh') {
    await runSshExec(device, req, sink, signal);
    return;
  }
  if (!sink.isOpen()) return;
  sink.emit({
    type: 'error',
    code: 'exec_unsupported_device',
    message: 'unsupported device type',
  });
}
