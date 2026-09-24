import { describe, expect, spyOn, test } from 'bun:test';
import type { WindowMemorySettings } from '@vibeterm/shared';

import {
  buildPropertyBatchScript,
  parsePropertyBatch,
  propertyBatchTimeoutMs,
  runPropertyBatch,
} from './property-batch';
import { type PaneMemoryState, type PlannedWrite, decideApply } from './tracker-ops';

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

function write(scope: string, kind: PlannedWrite['kind'] = 'release'): PlannedWrite {
  return {
    state: state(scope),
    kind,
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

const APPLY_SETTINGS: WindowMemorySettings = {
  enabled: true,
  memoryHighMb: 8192,
  memoryMaxMb: 12288,
  memorySwapMaxMb: 4096,
  sampleIntervalSec: 5,
};

function applyState(index: number): PaneMemoryState {
  const scope = `tmux-spawn-p${index}.scope`;
  return {
    ...state(scope),
    paneId: `%${index}`,
    sample: {
      paneId: `%${index}`,
      pid: 10 + index,
      scope,
      current: 1,
      high: 0,
      max: 0,
      swapMax: 0,
      oomKills: 0,
      managed: false,
      source: 'cgroup',
    },
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

  test('exit 124 keeps VTSET rows that arrived and does not burn the apply retry', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const states = [0, 1, 2].map(applyState);
    const writes = states.map((pane) => {
      const planned = decideApply(pane, APPLY_SETTINGS, 0);
      if (!planned) throw new Error('expected an apply');
      return planned;
    });
    const host = {
      runHostShell: async () => ({
        exitCode: 124,
        stdout: 'VTSET\ttmux-spawn-p0.scope\t0\t\n',
        stderr: 'timeout',
      }),
    };
    await runPropertyBatch(host, 'dev', writes, 0);
    expect(states[0]?.applyAttempts).toBe(0);
    expect(states[0]?.sample?.managed).toBe(true);
    expect(states[1]?.applyAttempts).toBe(1);
    expect(states[2]?.applyAttempts).toBe(1);
    expect(states[1]?.giveUpLogged).toBe(false);
    expect(states[2]?.giveUpLogged).toBe(false);
    expect(decideApply(states[1] as PaneMemoryState, APPLY_SETTINGS, 0)).toBeNull();
    expect(decideApply(states[2] as PaneMemoryState, APPLY_SETTINGS, 3_600_000)).not.toBeNull();
    expect(warn.mock.calls.some((args) => String(args[0]).includes('giving up'))).toBe(false);
    warn.mockRestore();
  });

  test('a non-timeout failure still fails the whole chunk and ignores partial VTSET', async () => {
    const pane = applyState(0);
    const other = applyState(1);
    const writes = [pane, other].map((item) => {
      const planned = decideApply(item, APPLY_SETTINGS, 0);
      if (!planned) throw new Error('expected an apply');
      return planned;
    });
    const host = {
      runHostShell: async () => ({
        exitCode: 1,
        stdout: 'VTSET\ttmux-spawn-p0.scope\t0\t\n',
        stderr: 'broken',
      }),
    };
    await runPropertyBatch(host, 'dev', writes, 0);
    expect(pane.applyAttempts).toBe(1);
    expect(other.applyAttempts).toBe(1);
    expect(pane.sample?.managed).toBe(false);
  });

  test('release timeout still counts as two attempts', async () => {
    const planned = write('tmux-spawn-aaa.scope', 'release');
    const host = {
      runHostShell: async () => ({ exitCode: 124, stdout: '', stderr: 'timeout' }),
    };
    await runPropertyBatch(host, 'dev', [planned], 0);
    expect(planned.state.applyAttempts).toBe(2);
  });

  test('chunks writes at 8 and scales the timeout with the chunk', async () => {
    const timeouts: number[] = [];
    const writes = Array.from({ length: 9 }, (_, index) => write(`tmux-spawn-p${index}.scope`));
    const host = {
      runHostShell: async (_script: string, opts?: { timeoutMs?: number }) => {
        timeouts.push(opts?.timeoutMs ?? 0);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await runPropertyBatch(host, 'dev', writes, 0);
    expect(timeouts).toEqual([propertyBatchTimeoutMs(8), propertyBatchTimeoutMs(1)]);
    expect(propertyBatchTimeoutMs(8)).toBe(18_000);
    expect(propertyBatchTimeoutMs(40)).toBe(50_000);
    expect(propertyBatchTimeoutMs(80)).toBe(60_000);
  });
});
