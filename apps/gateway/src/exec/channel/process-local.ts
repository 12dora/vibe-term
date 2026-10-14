import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExecCommand, ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import { getLocalShellPath } from '../../tmux/local-shell-path';
import { buildChannelEnv } from '../env';
import { ExecChannelError } from './errors';
import { DEFAULT_PTY_TERM, launchProcess } from './process-launch';
import type { ExecProcess } from './process-types';
import { resolveSftpServer, resolveUserShell, shellProbe } from './shell';

export function buildLocalArgv(command: ExecCommand, userShell: string): string[] {
  switch (command.kind) {
    case 'shell':
      return [command.sh ? '/bin/sh' : userShell, '-c', command.script];
    case 'argv':
      return command.argv;
    case 'login':
      return [userShell, '-l'];
    case 'subsystem':
      return [resolveSftpServer()];
  }
}

function resolveCwd(cwd: string | undefined): string {
  const home = shellProbe.home();
  const target = cwd === undefined ? home : resolve(home, cwd);
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new ExecChannelError('exec_spawn_failed', `working directory not found: ${target}`);
  }
  return target;
}

export function spawnLocalProcess(spec: ExecOpenSpec): ExecProcess {
  const userShell = resolveUserShell();
  const argv = buildLocalArgv(spec.command, userShell);
  const env = buildChannelEnv({
    shell: userShell,
    path: getLocalShellPath(),
    term: spec.pty ? (spec.pty.term ?? DEFAULT_PTY_TERM) : null,
    overlay: spec.env,
  });
  return launchProcess({
    argv,
    cwd: resolveCwd(spec.cwd),
    env,
    pty: spec.pty ?? null,
    stdin: spec.stdin,
    onExit: () => {},
  });
}
