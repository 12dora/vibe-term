import { describe, expect, test } from 'bun:test';
import {
  type EmulatorStreamSource,
  type PaneEmulator,
  PaneEmulatorRegistry,
} from '../tmux-client/pane-emulator';
import {
  acquireRunResources,
  asEmulatorSource,
  releaseHeldPaneEmulator,
  releaseRunResources,
} from './run-resource-scope';
import {
  type TerminalRuntimeLike,
  createTerminalToolContext,
  liveEmulator,
} from './tools/terminal-context';

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
        return 0;
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
        return 0;
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

  test('仍有持有者时只 release 不 destroy', async () => {
    const order: string[] = [];
    await releaseRunResources({
      emulator: fakeEmulator(),
      runtime: stubRuntime(),
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: async () => {
        order.push('emu-release');
        return 1;
      },
      destroyEmulator: async () => {
        order.push('emu-destroy');
      },
      releaseRuntime: async () => {
        order.push('runtime-release');
      },
    });
    expect(order).toEqual(['emu-release', 'runtime-release']);
  });

  test('两个 scope 共享同一 emulator：先释放的不销毁，后释放的才销毁', async () => {
    const registry = new PaneEmulatorRegistry();
    const source: EmulatorStreamSource = {
      subscribe() {
        return () => {};
      },
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
    const runtime = streamingRuntime();
    const first = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => runtime,
      acquireEmulator: (deviceId, paneId) => registry.acquire(deviceId, paneId, source),
    });
    const second = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => runtime,
      acquireEmulator: (deviceId, paneId) => registry.acquire(deviceId, paneId, source),
    });
    expect(first.emulator).not.toBeNull();
    expect(first.emulator).toBe(second.emulator);
    expect(first.emulator?.isDisposed).toBe(false);

    await releaseRunResources({
      emulator: first.emulator,
      runtime,
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: (deviceId, paneId) => registry.release(deviceId, paneId),
      destroyEmulator: (deviceId, paneId) => registry.destroy(deviceId, paneId),
      releaseRuntime: async () => {},
    });
    expect(first.emulator?.isDisposed).toBe(false);
    expect(registry.size).toBe(1);

    await releaseRunResources({
      emulator: second.emulator,
      runtime,
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: (deviceId, paneId) => registry.release(deviceId, paneId),
      destroyEmulator: (deviceId, paneId) => registry.destroy(deviceId, paneId),
      releaseRuntime: async () => {},
    });
    expect(first.emulator?.isDisposed).toBe(true);
    expect(registry.size).toBe(0);
  });

  test('fatal streak 只释放本 run 引用：共享 emulator 时另一 run 的 liveEmulator 仍可用', async () => {
    const registry = new PaneEmulatorRegistry();
    const source: EmulatorStreamSource = {
      subscribe() {
        return () => {};
      },
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
    const runtime = streamingRuntime();
    const first = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => runtime,
      acquireEmulator: (deviceId, paneId) => registry.acquire(deviceId, paneId, source),
    });
    const second = await acquireRunResources({
      deviceId: 'dev1',
      paneId: '%1',
      acquireRuntime: async () => runtime,
      acquireEmulator: (deviceId, paneId) => registry.acquire(deviceId, paneId, source),
    });
    expect(first.emulator).toBe(second.emulator);
    expect(first.emulator).not.toBeNull();

    await releaseHeldPaneEmulator({
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: (deviceId, paneId) => registry.release(deviceId, paneId),
      destroyEmulator: (deviceId, paneId) => registry.destroy(deviceId, paneId),
    });

    expect(second.emulator?.isDisposed).toBe(false);
    expect(registry.size).toBe(1);
    const otherCtx = createTerminalToolContext({
      paneId: '%1',
      deviceId: 'dev1',
      getRuntime: () => runtime,
      getEmulator: () => second.emulator,
      needsApprovalForWrite: false,
      onFailure: () => {},
      onSuccess: () => {},
    });
    expect(liveEmulator(otherCtx)).toBe(second.emulator);

    await releaseRunResources({
      emulator: second.emulator,
      runtime,
      deviceId: 'dev1',
      paneId: '%1',
      releaseEmulator: (deviceId, paneId) => registry.release(deviceId, paneId),
      destroyEmulator: (deviceId, paneId) => registry.destroy(deviceId, paneId),
      releaseRuntime: async () => {},
    });
    expect(second.emulator?.isDisposed).toBe(true);
    expect(registry.size).toBe(0);
  });
});
