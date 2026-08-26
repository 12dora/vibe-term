import { describe, expect, test } from 'bun:test';
import type { PaneEmulator } from '../../tmux-client/pane-emulator';
import {
  checkRuntimeAlive,
  createTerminalToolContext,
  failTool,
  liveEmulator,
} from './terminal-context';

function options(overrides: Partial<Parameters<typeof createTerminalToolContext>[0]> = {}) {
  return createTerminalToolContext({
    paneId: '%1',
    deviceId: 'dev1',
    getRuntime: () => null,
    needsApprovalForWrite: false,
    onFailure: () => {},
    onSuccess: () => {},
    ...overrides,
  });
}

describe('TerminalToolContext helpers', () => {
  test('failTool 计入 onFailure 并返回错误对象', () => {
    let failures = 0;
    const ctx = options({
      onFailure: () => {
        failures += 1;
      },
    });
    expect(failTool(ctx, 'boom')).toEqual({ error: 'boom' });
    expect(failures).toBe(1);
  });

  test('checkRuntimeAlive：默认视为存活；显式 false 则失败', () => {
    expect(checkRuntimeAlive(options())).toBeNull();
    const dead = options({ isRuntimeAlive: () => false });
    expect(checkRuntimeAlive(dead)).toEqual({
      error: 'Terminal connection is no longer available.',
    });
  });

  test('liveEmulator：null / disposed 回退为 null', () => {
    expect(liveEmulator(options())).toBeNull();
    const disposed = { isDisposed: true } as PaneEmulator;
    expect(liveEmulator(options({ getEmulator: () => disposed }))).toBeNull();
    const live = { isDisposed: false } as PaneEmulator;
    expect(liveEmulator(options({ getEmulator: () => live }))).toBe(live);
  });
});
