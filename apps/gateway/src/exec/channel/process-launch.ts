import type { ExecOpenSpec } from '@vibeterm/shared/exec-channel';
import { spawnFailed } from './errors';
import { type PipeProc, createPipeProcess } from './process-pipe';
import type { ExecProcess } from './process-types';
import { spawnPtyProcess } from './pty';

export const DEFAULT_PTY_TERM = 'xterm-256color';

export type LaunchOptions = {
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  pty: ExecOpenSpec['pty'];
  stdin: boolean;
  onExit: () => void;
};

export function launchProcess(opts: LaunchOptions): ExecProcess {
  if (opts.pty) {
    return spawnPtyProcess(opts.argv, {
      cwd: opts.cwd,
      env: opts.env,
      cols: opts.pty.cols,
      rows: opts.pty.rows,
      term: opts.pty.term ?? DEFAULT_PTY_TERM,
      onExit: opts.onExit,
    });
  }
  try {
    const proc = Bun.spawn(opts.argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    return createPipeProcess(proc as unknown as PipeProc, opts.onExit);
  } catch (err) {
    throw spawnFailed(err);
  }
}
