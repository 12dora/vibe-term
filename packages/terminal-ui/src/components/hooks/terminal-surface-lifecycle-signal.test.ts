// 首个终端内容绘制的一次性信号：外壳用它把 1.2 MB 的空闲预热推到终端出内容之后。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GatewayPaneScreenSnapshot } from '@vibeterm/ws-client';
import type { SnapshotCommitInfo } from '../TerminalSurface';
import {
  type TerminalSurfaceCreationContext,
  TerminalSurfaceLifecycle,
  type TerminalSurfaceLifecycleDeps,
} from './terminal-surface-lifecycle';
import {
  hasFirstTerminalScreenPainted,
  markFirstTerminalScreenPainted,
  resetFirstTerminalScreenPaintedForTest,
  whenFirstTerminalScreenPainted,
} from './terminal-surface-lifecycle-signal';

interface FakeTarget {
  dispose(): void;
}

const SNAPSHOT = { data: new Uint8Array() } as unknown as GatewayPaneScreenSnapshot;
const COMMIT: SnapshotCommitInfo = { gridResized: true, viewportAnchor: null };

beforeEach(() => {
  resetFirstTerminalScreenPaintedForTest();
});

afterEach(() => {
  resetFirstTerminalScreenPaintedForTest();
});

describe('first terminal screen paint signal', () => {
  test('初始未绘制，mark 之后 promise 兑现且状态置位', async () => {
    expect(hasFirstTerminalScreenPainted()).toBe(false);
    let settled = false;
    void whenFirstTerminalScreenPainted().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    markFirstTerminalScreenPainted();
    expect(hasFirstTerminalScreenPainted()).toBe(true);
    await whenFirstTerminalScreenPainted();
    expect(settled).toBe(true);
  });

  test('绘制之后再订阅拿到的是已兑现的 promise', async () => {
    markFirstTerminalScreenPainted();
    await expect(whenFirstTerminalScreenPainted()).resolves.toBeUndefined();
  });

  test('重复 mark 幂等', () => {
    markFirstTerminalScreenPainted();
    markFirstTerminalScreenPainted();
    expect(hasFirstTerminalScreenPainted()).toBe(true);
  });
});

describe('lifecycle 触发信号', () => {
  function bootWith(): { emit: (snapshot: GatewayPaneScreenSnapshot | null) => void } {
    let handlers: TerminalSurfaceCreationContext<FakeTarget> | null = null;
    const target: FakeTarget = { dispose: () => {} };
    const deps: TerminalSurfaceLifecycleDeps<FakeTarget> = {
      loadResources: () => undefined,
      createSurface(context) {
        handlers = context;
        return {
          initialize: () => Promise.resolve(target),
          dispose: () => {},
          getVisibleTarget: () => target,
        };
      },
      getSurface: () => null,
      setSurface: () => {},
      bindTarget: () => {},
      setBootState: () => {},
      reportStage: () => {},
      startDiagnosticSamples: () => () => {},
      supportsAtomicScreen: () => true,
      requestPaneScreen: () => {},
      onSnapshotCommitted: () => {},
    };
    void new TerminalSurfaceLifecycle(deps).boot();
    return { emit: (snapshot) => handlers?.onSnapshotApplied(target, snapshot, COMMIT) };
  }

  test('空快照（还没有内容）不算绘制', () => {
    bootWith().emit(null);
    expect(hasFirstTerminalScreenPainted()).toBe(false);
  });

  test('首个真实快照落地即视为首帧', () => {
    const { emit } = bootWith();
    emit(null);
    emit(SNAPSHOT);
    expect(hasFirstTerminalScreenPainted()).toBe(true);
  });
});
