import { decryptWithContext } from '../crypto';
import { resolveOpenSshTarget } from '../files/ssh-target';
import { resolveSshConnectConfig } from '../tmux-client/ssh-connect-config';
import type { ExecProc } from './child';

export type ExecSpawnOpts = {
  cwd?: string;
  env?: Record<string, string>;
  stdin: 'pipe' | 'ignore';
  stdout: 'pipe';
  stderr: 'pipe';
};

export type ExecSpawn = (argv: string[], opts: ExecSpawnOpts) => ExecProc;

export const execIo = {
  spawn: ((argv, opts) => Bun.spawn(argv, opts) as unknown as ExecProc) as ExecSpawn,
  resolveSsh: resolveOpenSshTarget,
  decrypt: decryptWithContext,
  resolveSshConfig: resolveSshConnectConfig,
};
