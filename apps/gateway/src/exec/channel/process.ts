import type { Device } from '@vibeterm/shared';
import type { ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import { ExecChannelError } from './errors';
import { spawnLocalProcess } from './process-local';
import { spawnSshProcess } from './process-ssh';
import type { ExecProcess } from './process-types';

export type { ExecProcess, ExecProcessExit } from './process-types';
export { ExecChannelError } from './errors';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertEnvKeys(env: Record<string, string> | undefined): void {
  for (const key of Object.keys(env ?? {})) {
    if (!ENV_KEY.test(key)) {
      throw new ExecChannelError('invalid_request', `invalid environment variable name: ${key}`);
    }
  }
}

/** 子系统走二进制协议，不分配 PTY。 */
function normalizeSpec(spec: ExecOpenSpec): ExecOpenSpec {
  return spec.command.kind === 'subsystem' && spec.pty ? { ...spec, pty: null } : spec;
}

export async function spawnExecProcess(device: Device, spec: ExecOpenSpec): Promise<ExecProcess> {
  assertEnvKeys(spec.env);
  const normalized = normalizeSpec(spec);
  if (device.type === 'local') return spawnLocalProcess(normalized);
  if (device.type === 'ssh') return await spawnSshProcess(device, normalized);
  throw new ExecChannelError('exec_unsupported_device', 'unsupported device type');
}
