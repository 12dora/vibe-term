import { describe, expect, test } from 'bun:test';
import type { EmulatorStreamSource, PaneEmulator } from '../tmux-client/pane-emulator';
import { acquireRunResources, asEmulatorSource, releaseRunResources } from './run-resource-scope';
import type { TerminalRuntimeLike } from './tools/terminal-context';

function stubRuntime(): TerminalRuntimeLike {
  return {
    sendInput() {},
    async capturePaneText() {
      return '';
    },
    async getPaneInfo() {
      return {
        cols: 80,
        rows: 24,
        cursorX: 0,
        cursorY: 0,
        alternateScreen: false,
        currentCommand: 'bash',
      };
    },
  };
}

function streamingRuntime(): TerminalRuntimeLike & EmulatorStreamSource {
  return {
    ...stubRuntime(),
    subscribe() {
      return () => {};
    },
  };
}

function fakeEmulator(): PaneEmulator {
  return { id: 'emu' } as unknown as PaneEmulator;
}

describe('asEmulatorSource', () => {
  test('缺 subscribe / capture / getPaneInfo 任一则视为非模拟器源', () => {
    expect(asEmulatorSource(stubRuntime())).toBeNull();
    expect(asEmulatorSource(streamingRuntime())).not.toBeNull();
    expect(asEmulatorSource({ subscribe() {}, capturePaneText() {} })).toBeNull();
  });
});

describe('acquireRunResources', () => {
  test('无 deviceId 或 paneId 时不获取 runtime/emulator', async () => {
    let acquired = 0;
    const result = await acquireRunResources({
      deviceId: null,
      paneId: '%1',
      acquireRuntime: async () => {
        acquired += 1;
        return stubRuntime();
      },
    });
    expect(acquired).toBe(0);
    expect(result).toEqual({ runtime: null, emulator: null, runtimeError: null });
  });

  test('runtime 获取失败返回 runtimeError，不碰 emulator', async () => {
    let emulatorCalls = 0;
    const result = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => {
        throw new Error('ssh down');
      },
      acquireEmulator: async () => {
        emulatorCalls += 1;
        return fakeEmulator();
      },
    });
    expect(emulatorCalls).toBe(0);
    expect(result.runtime).toBeNull();
    expect(result.emulator).toBeNull();
    expect(result.runtimeError).toBe('failed to acquire terminal runtime: ssh down');
  });

  test('runtime 无流订阅能力时不获取 emulator', async () => {
    let emulatorCalls = 0;
    const runtime = stubRuntime();
    const result = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => runtime,
      acquireEmulator: async () => {
        emulatorCalls += 1;
        return fakeEmulator();
      },
    });
    expect(emulatorCalls).toBe(0);
    expect(result.runtime).toBe(runtime);
    expect(result.emulator).toBeNull();
    expect(result.runtimeError).toBeNull();
  });

  test('emulator 获取失败只记日志，runtime 仍返回', async () => {
    const runtime = streamingRuntime();
    const result = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => runtime,
      acquireEmulator: async () => {
        throw new Error('wasm missing');
      },
    });
    expect(result.runtime).toBe(runtime);
    expect(result.emulator).toBeNull();
    expect(result.runtimeError).toBeNull();
  });
});

describe('releaseRunResources', () => {
  test('释放顺序：emulator release → emulator destroy → runtime release', async () => {
    const order: string[] = [];
    const runtime = stubRuntime();
    const emulator = fakeEmulator();
    await releaseRunResources({
      emulator,
      runtime,
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: async () => {
        order.push('emu-release');
      },
      destroyEmulator: async () => {
        order.push('emu-destroy');
      },
      releaseRuntime: async () => {
        order.push('runtime-release');
      },
    });
    expect(order).toEqual(['emu-release', 'emu-destroy', 'runtime-release']);
  });

  test('emulator 已为空时跳过 emulator 释放，仍释放 runtime', async () => {
    const order: string[] = [];
    await releaseRunResources({
      emulator: null,
      runtime: stubRuntime(),
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: async () => {
        order.push('emu-release');
      },
      destroyEmulator: async () => {
        order.push('emu-destroy');
      },
      releaseRuntime: async () => {
        order.push('runtime-release');
      },
    });
    expect(order).toEqual(['runtime-release']);
  });

  test('runtime 为空时不释放 runtime（acquire 失败路径）', async () => {
    const order: string[] = [];
    await releaseRunResources({
      emulator: null,
      runtime: null,
      deviceId: 'dev1',
      paneId: '%1',
      releaseRuntime: async () => {
        order.push('runtime-release');
      },
    });
    expect(order).toEqual([]);
  });

  test('release/destroy 抛错被吞掉，后续步骤仍执行', async () => {
    const order: string[] = [];
    await releaseRunResources({
      emulator: fakeEmulator(),
      runtime: stubRuntime(),
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: async () => {
        order.push('emu-release');
        throw new Error('release fail');
      },
      destroyEmulator: async () => {
        order.push('emu-destroy');
        throw new Error('destroy fail');
      },
      releaseRuntime: async () => {
        order.push('runtime-release');
      },
    });
    expect(order).toEqual(['emu-release', 'emu-destroy', 'runtime-release']);
  });
});
