import { describe, expect, test } from 'bun:test';

import { buildPropertyBatchScript, parsePropertyBatch } from './property-batch';
import type { PaneMemoryState, PlannedWrite } from './tracker-ops';

function state(scope: string): PaneMemoryState {
  return {
    paneId: `%${scope}`,
    windowId: '@1',
    windowName: 'main',
    scope,
    sample: null,
    oomKills: 0,
    applyAttempts: 0,
    applyFailedAt: null,
    desiredKey: '',
    lastStderr: '',
    giveUpLogged: false,
    releaseUnverified: false,
  };
}

function write(scope: string): PlannedWrite {
  return {
    state: state(scope),
    kind: 'release',
    args: [
      'systemctl',
      '--user',
      'set-property',
      '--runtime',
      scope,
      'MemoryHigh=infinity',
      'MemoryMax=infinity',
      'MemorySwapMax=infinity',
    ],
  };
}

describe('property batch script', () => {
  test('one script carries every scope and is valid sh', async () => {
    const script = buildPropertyBatchScript([
      write('tmux-spawn-aaa.scope'),
      write('tmux-spawn-bbb.scope'),
    ]);
    expect(script.match(/set-property/g)).toHaveLength(2);
    expect(script.indexOf('DBUS_SESSION_BUS_ADDRESS')).toBeLessThan(script.indexOf('systemctl'));
    expect(script).toContain('VTSET_BATCH');
    const proc = Bun.spawn(['sh', '-n', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('parses per-scope exit codes', () => {
    const rows = parsePropertyBatch(
      'VTSET\ttmux-spawn-aaa.scope\t0\t\nVTSET\ttmux-spawn-bbb.scope\t1\tFailed to connect to bus\n'
    );
    expect(rows.get('tmux-spawn-aaa.scope')).toEqual({ code: 0, stderr: '' });
    expect(rows.get('tmux-spawn-bbb.scope')).toEqual({
      code: 1,
      stderr: 'Failed to connect to bus',
    });
  });
});
