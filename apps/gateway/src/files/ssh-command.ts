import type { Device, FileErrorCode } from '@vibeterm/shared';
import { decryptWithContext } from '../crypto';
import { quoteShellArg } from '../tmux-client/command-builder';
import { resolveSshConnectConfig } from '../tmux-client/ssh-connect-config';
import { resolveOpenSshTarget } from './ssh-target';

export class RsyncAuthError extends Error {
  code: FileErrorCode;
  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = 'RsyncAuthError';
    this.code = code;
  }
}

export interface RsyncDeviceSpec {
  // ssh 目标前缀：local 设备为 ''（直接用本地路径）；ssh 为 'user@host:'
  targetPrefix: string;
  // rsync 的 -e 值（ssh 命令串，按空格切分，故各 token 不能含空格）；local 为 undefined
  rsh: string | undefined;
  // 额外环境变量（如 SSH_AUTH_SOCK / SSH_ASKPASS 链路）
  env: Record<string, string>;
  cleanup: () => void;
}

export async function buildRsyncDeviceSpec(
  device: Device,
  decrypt: typeof decryptWithContext = decryptWithContext,
  resolveConfig: typeof resolveSshConnectConfig = resolveSshConnectConfig
): Promise<RsyncDeviceSpec> {
  if (device.type === 'local') {
    return { targetPrefix: '', rsh: undefined, env: {}, cleanup: () => {} };
  }
  const resolved = await resolveOpenSshTarget(device, decrypt, resolveConfig);
  if (!resolved.ok) {
    throw new RsyncAuthError(resolved.code, resolved.message);
  }
  const { dest, sshArgs, env, cleanup } = resolved.target;
  return { targetPrefix: `${dest}:`, rsh: sshArgs.join(' '), env, cleanup };
}

export function rsyncTargetArg(spec: RsyncDeviceSpec, remotePath: string): string {
  if (!spec.targetPrefix) return remotePath;
  return `${spec.targetPrefix}${quoteShellArg(remotePath)}`;
}

export function rsyncListArgs(spec: RsyncDeviceSpec, remotePath: string): string[] {
  const args = ['--list-only', '--8-bit-output'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(rsyncTargetArg(spec, remotePath));
  return args;
}

export function rsyncCopyArgs(spec: RsyncDeviceSpec, remotePath: string, dest: string): string[] {
  const args = ['-L', '--progress'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(rsyncTargetArg(spec, remotePath), dest);
  return args;
}

export function rsyncUploadArgs(
  spec: RsyncDeviceSpec,
  localSource: string,
  remoteDest: string
): string[] {
  const args: string[] = ['--progress'];
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(localSource, rsyncTargetArg(spec, remoteDest));
  return args;
}
