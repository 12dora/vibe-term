import { describe, expect, test } from 'bun:test';
import type { TerminalSizeSnapshot } from '../utils/resizeSyncGuards';
import {
  type ViewportRestorePendingState,
  createViewportRestoreController,
} from './terminal-viewport-restore';

interface Harness {
  controller: ReturnType<typeof createViewportRestoreController>;
  pending: ViewportRestorePendingState;
  calls: string[];
  setCurrentSize: (size: TerminalSizeSnapshot | null) => void;
  setContainerSize: (size: TerminalSizeSnapshot | null) => void;
}

function createHarness(): Harness {
  const state = {
    current: { cols: 80, rows: 24 } as TerminalSizeSnapshot | null,
    container: { cols: 80, rows: 24 } as TerminalSizeSnapshot | null,
  };
  const calls: string[] = [];
  const pending: ViewportRestorePendingState = { current: false };

  const controller = createViewportRestoreController({
    pending,
    getCurrentSize: () => state.current,
    measureContainerSize: () => state.container,
    forceFullRepaint: () => calls.push('repaint'),
    requestSync: () => calls.push('sync'),
  });

  return {
    controller,
    pending,
    calls,
    setCurrentSize: (size) => {
      state.current = size;
    },
    setContainerSize: (size) => {
      state.container = size;
    },
  };
}

describe('createViewportRestoreController.restore', () => {
  test('尺寸一致时只强制全量重绘', () => {
    const harness = createHarness();
    expect(harness.controller.restore()).toBe('repainted');
    expect(harness.calls).toEqual(['repaint']);
  });

  test('尺寸不一致时请求 sync', () => {
    const harness = createHarness();
    harness.setContainerSize({ cols: 120, rows: 40 });
    expect(harness.controller.restore()).toBe('synced');
    expect(harness.calls).toEqual(['sync']);
  });

  test('终端缺失或容器不可测量时跳过', () => {
    const noTerminal = createHarness();
    noTerminal.setCurrentSize(null);
    expect(noTerminal.controller.restore()).toBe('skipped');
    expect(noTerminal.calls).toEqual([]);

    const hidden = createHarness();
    hidden.setContainerSize(null);
    expect(hidden.controller.restore()).toBe('skipped');
    expect(hidden.calls).toEqual([]);
  });
});

describe('createViewportRestoreController 的挂起状态机', () => {
  test('页面隐藏后重新可见触发恢复', () => {
    const harness = createHarness();
    harness.setContainerSize({ cols: 120, rows: 40 });

    harness.controller.handleVisibilityChange(false);
    expect(harness.pending.current).toBe(true);
    expect(harness.calls).toEqual([]);

    harness.controller.handleVisibilityChange(true);
    expect(harness.pending.current).toBe(false);
    expect(harness.calls).toEqual(['sync']);
  });

  test('未曾隐藏过时可见事件不触发恢复', () => {
    const harness = createHarness();
    harness.controller.handleVisibilityChange(true);
    expect(harness.calls).toEqual([]);
  });

  test('blur 后 focus 触发恢复，且只触发一次', () => {
    const harness = createHarness();
    harness.setContainerSize({ cols: 120, rows: 40 });

    harness.controller.handleWindowBlur();
    harness.controller.handleWindowFocus();
    harness.controller.handleWindowFocus();

    expect(harness.calls).toEqual(['sync']);
  });

  test('挂起状态在控制器重建之间由外部持有', () => {
    const harness = createHarness();
    harness.controller.handleWindowBlur();
    expect(harness.pending.current).toBe(true);

    const rebuilt = createViewportRestoreController({
      pending: harness.pending,
      getCurrentSize: () => ({ cols: 80, rows: 24 }),
      measureContainerSize: () => ({ cols: 120, rows: 40 }),
      forceFullRepaint: () => harness.calls.push('repaint'),
      requestSync: () => harness.calls.push('sync'),
    });

    rebuilt.handleWindowFocus();
    expect(harness.calls).toEqual(['sync']);
    expect(harness.pending.current).toBe(false);
  });
});
