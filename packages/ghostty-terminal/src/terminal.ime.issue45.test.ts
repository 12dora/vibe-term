import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import {
  type FakeBindings,
  type FakeDom,
  TEST_THEME,
  createFakeBindings,
  disposeTrackedTerminals,
  findHelperTextarea,
  installFakeDom,
  mockGhosttyWasm,
  restoreRealTerminalModules,
  trackTerminal,
} from './test-support/fake-dom';
import type { GhosttyTerminalInitOptions } from './types';

// issue-45 bug 4-C 红测：syncTextareaPositionToCursor 路径不应消费 dirty。
// 当前 terminal.ts:1409 会调 updateRenderState → rAF 漏画；Task 9 改读 lastCursor 后转绿。

// mock updateRenderState 为计数 spy，靠 composition 派发前后调用增量断言 syncTextarea 路径。
interface UpdateRenderStateCall {
  state: unknown;
  terminal: unknown;
}

async function loadControllerModule(
  bindings: FakeBindings,
  version: number,
  calls: UpdateRenderStateCall[]
) {
  mock.restore();
  mockGhosttyWasm(bindings);

  const cursor = {
    style: 'block' as const,
    visible: true,
    blinking: false,
    passwordInput: false,
    x: 1,
    y: 0,
    wideTail: false,
  };

  mock.module('./render-state', () => ({
    createRenderState: () => ({
      snapshotVersion: 0,
      disposed: false,
      rowIteratorHandle: 7,
      rowCellsHandle: 8,
      renderStateHandle: 9,
      bindings,
      cachedMeta: null,
    }),
    updateRenderState: (state: { snapshotVersion: number }, terminal: unknown) => {
      state.snapshotVersion += 1;
      calls.push({ state, terminal });
    },
    readRenderSnapshotMeta: () => ({
      cols: 80,
      rows: 24,
      dirty: 'full',
      colors: {
        background: { r: 17, g: 17, b: 17 },
        foreground: { r: 238, g: 238, b: 238 },
        cursor: { r: 255, g: 255, b: 255 },
        palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
      },
      cursor,
    }),
    iterateRows: function* () {},
    disposeRenderStateResources: (state: { disposed: boolean }) => {
      state.disposed = true;
    },
  }));

  const controllerModule = await import(`./terminal.ts?issue45-ime-${version}`);

  return {
    ...controllerModule,
    createTerminalController: async (options: GhosttyTerminalInitOptions) =>
      trackTerminal(await controllerModule.createTerminalController(options)),
  };
}

afterAll(restoreRealTerminalModules);

describe('issue45 bug 4-C: syncTextareaPositionToCursor should not consume dirty', () => {
  let dom: FakeDom | null = null;
  let importVersion = 0;

  afterEach(() => {
    disposeTrackedTerminals();
    dom?.restore();
    dom = null;
    mock.restore();
  });

  test('issue45 composition updateRenderState calls during composition are zero before rAF', async () => {
    dom = installFakeDom();
    const bindings = createFakeBindings();
    importVersion += 1;

    const updateCalls: UpdateRenderStateCall[] = [];
    const { createTerminalController } = await loadControllerModule(
      bindings,
      importVersion,
      updateCalls
    );

    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });

    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 960, height: 480 });
    dom.document.body.appendChild(container);

    terminal.open(container as unknown as HTMLElement);
    await dom.flushAnimationFrames();

    const textarea = findHelperTextarea(dom.document.body);
    expect(textarea).toBeDefined();
    if (!textarea) return;

    // 红测时序：writeVt('A') → 排队 rAF → composition 事件 → rAF 触发前断言
    terminal.write('A');
    expect(dom.pendingAnimationFrames()).toBeGreaterThan(0);

    const baseline = updateCalls.length;
    const leftBefore = textarea.style.left;

    // compositionstart/update → syncTextareaPositionToCursor（terminal.ts:1057/1061），
    // bug 路径每次会调 updateRenderState 消费 dirty；Task 9 改读 lastCursor 后转绿。
    textarea.dispatchEvent({ type: 'compositionstart', data: '' });
    textarea.dispatchEvent({ type: 'compositionupdate', data: 'n' });

    // 卫士：style.left 被改写（cursor.x=1）证明事件确实进了 syncTextareaPositionToCursor，
    // 否则下面的调用次数断言形同虚设。
    expect(textarea.style.left).not.toEqual(leftBefore);
    expect(textarea.style.left).toMatch(/^[0-9.]+px$/);

    const callsDuringComposition = updateCalls.length - baseline;
    expect(callsDuringComposition).toBe(0);

    await dom.flushAnimationFrames();

    const callsAfterRaf = updateCalls.length - baseline;
    expect(callsAfterRaf).toBe(1);

    terminal.dispose();
  });
});
