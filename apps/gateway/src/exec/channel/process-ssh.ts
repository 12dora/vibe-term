import type { Device } from '@vibeterm/shared';
import type { ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import type { OpenSshTarget } from '../../files/ssh-target';
import { quoteShellArg } from '../../tmux-client/command-builder';
import { mergedServiceEnv } from '../env';
import { execIo } from '../io';
import { buildSshRemoteCommand } from '../remote-command';
import { ExecChannelError } from './errors';
import { DEFAULT_PTY_TERM, launchProcess } from './process-launch';
import type { ExecProcess } from './process-types';

type SshTarget = Pick<OpenSshTarget, 'dest' | 'sshArgs'>;

export function buildSshRemote(spec: ExecOpenSpec): string | null {
  const { command, cwd, env } = spec;
  switch (command.kind) {
    case 'argv':
      return buildSshRemoteCommand({ argv: command.argv, shell: false, cwd, env });
    case 'shell':
      return command.sh
        ? buildSshRemoteCommand({ argv: [command.script], shell: true, cwd, env })
        : withContext(command.script, cwd, env);
    case 'login':
      return cwd || hasEnv(env) ? withContext('exec "$SHELL" -l', cwd, env) : null;
    case 'subsystem':
      return 'sftp';
  }
}

function hasEnv(env: Record<string, string> | undefined): env is Record<string, string> {
  return env !== undefined && Object.keys(env).length > 0;
}

// 远端 shell 按 POSIX 语法解析 export / `||`；csh 系登录 shell 不受支持，需用 sh 模式。
function withContext(
  script: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined
): string {
  const exports = hasEnv(env)
    ? `export ${Object.entries(env)
        .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
        .join(' ')}; `
    : '';
  const chdir = cwd ? `cd ${quoteShellArg(cwd)} || exit 1; ` : '';
  return `${exports}${chdir}${script}`;
}

const SSH_KEEPALIVE_ARGS = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

export function buildSshArgv(target: SshTarget, spec: ExecOpenSpec): string[] {
  const head = [...target.sshArgs, ...SSH_KEEPALIVE_ARGS];
  if (spec.command.kind === 'subsystem') return [...head, '-T', '-s', target.dest, 'sftp'];
  const flags = spec.pty ? ['-tt', '-e', 'none'] : ['-T'];
  const remote = buildSshRemote(spec);
  return remote === null
    ? [...head, ...flags, target.dest]
    : [...head, ...flags, target.dest, '--', remote];
}

function unsupported(message: string): ExecChannelError {
  return new ExecChannelError('exec_unsupported_device', message);
}

export async function spawnSshProcess(device: Device, spec: ExecOpenSpec): Promise<ExecProcess> {
  const resolved = await execIo.resolveSsh(device, execIo.decrypt, execIo.resolveSshConfig);
  if (!resolved.ok) {
    throw resolved.code === 'auth_unsupported'
      ? unsupported(resolved.message)
      : new ExecChannelError('exec_spawn_failed', resolved.message);
  }
  const { target } = resolved;
  if (target.interactive) {
    target.cleanup();
    throw unsupported('password-auth SSH devices are not supported');
  }
  try {
    const env = mergedServiceEnv(target.env);
    if (spec.pty) env.TERM = spec.pty.term ?? DEFAULT_PTY_TERM;
    return launchProcess({
      argv: buildSshArgv(target, spec),
      env,
      pty: spec.pty ?? null,
      stdin: spec.stdin,
      onExit: target.cleanup,
    });
  } catch (err) {
    target.cleanup();
    throw err;
  }
}
