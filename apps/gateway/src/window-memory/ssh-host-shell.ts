import { errorMessage } from '@vibeterm/shared';

import { quoteShellArg } from '../tmux-client/command-builder';
import { HOST_SHELL_MAX_OUTPUT_BYTES, HOST_SHELL_TIMEOUT_MS } from './constants';
import type { HostShellResult } from './types';

export async function runSshHostShell(
  exec: (command: string, maxOutputBytes: number, timeoutMs: number) => Promise<HostShellResult>,
  script: string,
  opts?: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<HostShellResult> {
  const timeoutMs = opts?.timeoutMs ?? HOST_SHELL_TIMEOUT_MS;
  const maxOutputBytes = opts?.maxOutputBytes ?? HOST_SHELL_MAX_OUTPUT_BYTES;
  try {
    return await exec(`sh -c ${quoteShellArg(script)}`, maxOutputBytes, timeoutMs);
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: errorMessage(error) };
  }
}
