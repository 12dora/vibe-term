import { constants, accessSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolveLocalDefaultShell } from '../../tmux/local-shell-path';
import { ExecChannelError } from './errors';

const SFTP_SERVER_CANDIDATES = [
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server',
  '/usr/lib/ssh/sftp-server',
  '/usr/lib/sftp-server',
  '/opt/homebrew/libexec/sftp-server',
  '/usr/local/libexec/sftp-server',
];

export const shellProbe = {
  accountShell: (): string | null => {
    try {
      return userInfo().shell || null;
    } catch {
      return null;
    }
  },
  fallbackShell: resolveLocalDefaultShell,
  isExecutable,
  home: (): string => homedir(),
};

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveUserShell(): string {
  const account = shellProbe.accountShell();
  if (account && shellProbe.isExecutable(account)) return account;
  const fallback = shellProbe.fallbackShell();
  if (fallback && shellProbe.isExecutable(fallback)) return fallback;
  return '/bin/sh';
}

export function resolveSftpServer(): string {
  for (const candidate of SFTP_SERVER_CANDIDATES) {
    if (shellProbe.isExecutable(candidate)) return candidate;
  }
  throw new ExecChannelError('exec_spawn_failed', 'sftp-server not found on this node');
}
