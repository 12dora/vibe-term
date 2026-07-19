import { afterEach, describe, expect, test } from 'bun:test';

import { config } from '../config';
import { type TmuxHealthRunner, probeTmuxHealth } from './tmux-health';

const originalTmuxBin = config.tmuxBin;
const originalTmuxSocket = config.tmuxSocket;

afterEach(() => {
  (config as { tmuxBin: string }).tmuxBin = originalTmuxBin;
  (config as { tmuxSocket: string }).tmuxSocket = originalTmuxSocket;
});

function sequence(
  results: Array<{ exitCode: number; stdout: string; stderr: string }>,
  calls: string[][]
): TmuxHealthRunner {
  return async (argv) => {
    calls.push(argv);
    const next = results.shift();
    if (!next) throw new Error('unexpected command');
    return next;
  };
}

describe('probeTmuxHealth', () => {
  test('uses the configured absolute client and accepts an exact existing server version', async () => {
    (config as { tmuxBin: string }).tmuxBin = '/opt/homebrew/bin/tmux';
    (config as { tmuxSocket: string }).tmuxSocket = 'isolated';
    const calls: string[][] = [];
    const result = await probeTmuxHealth(
      sequence(
        [
          { exitCode: 0, stdout: 'tmux 3.7b\n', stderr: '' },
          { exitCode: 0, stdout: '3.7b\n', stderr: '' },
        ],
        calls
      )
    );

    expect(result).toEqual({
      healthy: true,
      clientVersion: 'tmux 3.7b',
      serverVersion: '3.7b',
      reason: 'ok',
    });
    expect(calls).toEqual([
      ['/opt/homebrew/bin/tmux', '-L', 'isolated', '-V'],
      ['/opt/homebrew/bin/tmux', '-L', 'isolated', 'display-message', '-p', '#{version}'],
    ]);
  });

  test('treats no existing server as ready without creating or mutating a session', async () => {
    const calls: string[][] = [];
    const result = await probeTmuxHealth(
      sequence(
        [
          { exitCode: 0, stdout: 'tmux 3.7b\n', stderr: '' },
          { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/tmux/default' },
        ],
        calls
      )
    );

    expect(result.healthy).toBeTrue();
    expect(result.reason).toBe('no_server');
    expect(calls[1]?.slice(-3)).toEqual(['display-message', '-p', '#{version}']);
  });

  test('fails closed for a mismatched server, unavailable client, or ambiguous probe error', async () => {
    const mismatch = await probeTmuxHealth(
      sequence(
        [
          { exitCode: 0, stdout: 'tmux 3.5a\n', stderr: '' },
          { exitCode: 0, stdout: '3.7b\n', stderr: '' },
        ],
        []
      )
    );
    expect(mismatch).toMatchObject({ healthy: false, reason: 'version_mismatch' });

    const unavailable = await probeTmuxHealth(
      sequence([{ exitCode: -1, stdout: '', stderr: 'ENOENT' }], [])
    );
    expect(unavailable).toMatchObject({ healthy: false, reason: 'client_unavailable' });

    const ambiguous = await probeTmuxHealth(
      sequence(
        [
          { exitCode: 0, stdout: 'tmux 3.7b\n', stderr: '' },
          { exitCode: 1, stdout: '', stderr: 'permission denied' },
        ],
        []
      )
    );
    expect(ambiguous).toMatchObject({ healthy: false, reason: 'server_probe_failed' });
  });
});
