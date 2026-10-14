import type { ExecChannelErrorCode } from '@vibeterm/shared/exec-channel';

export class ExecChannelError extends Error {
  constructor(
    readonly code: ExecChannelErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ExecChannelError';
  }
}

export function spawnFailed(err: unknown): ExecChannelError {
  return new ExecChannelError(
    'exec_spawn_failed',
    err instanceof Error ? err.message : String(err)
  );
}
