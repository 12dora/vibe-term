export interface RunSyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function defaultRunSync(cmd: string[]): RunSyncResult {
  const result = Bun.spawnSync(cmd, {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}
