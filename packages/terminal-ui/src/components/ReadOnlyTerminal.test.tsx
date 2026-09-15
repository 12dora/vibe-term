import { describe, expect, mock, test } from 'bun:test';
import type { HostServices } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { GhosttyTerminalInitOptions } from 'ghostty-terminal';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ReactI18nRuntime from 'react-i18next';

installWindowStorage();

mock.module('react-i18next', () => ({
  ...ReactI18nRuntime,
  useTranslation: () => ({ t: (key: string) => key, i18n: {}, ready: true }),
}));

const { createAppRuntime } = await import('@vibeterm/stores');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { resolveFontStack } = await import('@vibeterm/theme');
const {
  PanOriginPolicy,
  ReadOnlyTerminalSession,
  bootReadOnlyTerminal,
  buildReadOnlyControllerOptions,
  isReadOnlyCopyShortcut,
  mountHasPositiveSize,
  readOnlyTerminalSettingsFromUi,
  schedulePostPaintRefit,
  unionReadOnlyGrid,
} = await import('./hooks/read-only-terminal-session');
type ReadOnlyController = import('./hooks/read-only-terminal-session').ReadOnlyController;
const { ReadOnlySelectionToolbar, ReadOnlyTerminal } = await import('./ReadOnlyTerminal');
const { resolveInitialTerminalGrid } = await import('./terminal-initial-grid');
const { clearE2eReadOnlyTerminalProbe, setE2eReadOnlyTerminalProbe } = await import(
  './hooks/useReadOnlyTerminal'
);

function recordingHost(writes: string[]): HostServices {
  return {
    navigate: () => {},
    isMobile: () => false,
    openMobileSidebar: () => {},
    closeMobileSidebar: () => {},
    writeClipboardText: async (text) => {
      writes.push(text);
    },
    readClipboardText: async () => '',
    openExternal: () => {},
    reload: () => {},
    saveFile: async () => {},
  };
}

function createMount(width: number, height: number) {
  const box = { width, height };
  return {
    box,
    get clientWidth() {
      return box.width;
    },
    get clientHeight() {
      return box.height;
    },
    getBoundingClientRect: () => ({
      width: box.width,
      height: box.height,
      top: 0,
      left: 0,
      right: box.width,
      bottom: box.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    querySelector: () => null,
    closest: () => null,
  };
}

/** 假 FitAddon：只报容器能放下多少，网格由 session 按「容器 ∪ 包络」下发。 */
function createFakeFit(events: string[] = [], proposal = { cols: 100, rows: 30 }) {
  return {
    events,
    proposal,
    proposeDimensions() {
      events.push('propose');
      return proposal.cols > 0 && proposal.rows > 0 ? { ...proposal } : null;
    },
    dispose() {
      events.push('fit-dispose');
    },
    activate() {},
  };
}

function createFakeController(options: GhosttyTerminalInitOptions) {
  const viewport = {
    scrollLeft: 0,
    scrollTop: 0,
    listeners: [] as Array<() => void>,
    addEventListener(_type: string, listener: () => void) {
      this.listeners.push(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      this.listeners = this.listeners.filter((item) => item !== listener);
    },
  };
  const panCalls: boolean[] = [];
  const controller = {
    options,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    element: {
      querySelector: (selector: string) =>
        selector === '[data-pan-viewport="true"]' && panCalls.at(-1) === true ? viewport : null,
    },
    textarea: null,
    viewport,
    panCalls,
    resizeCalls: [] as Array<[number, number]>,
    writes: [] as Array<string | Uint8Array>,
    disposed: false,
    open() {},
    dispose() {
      controller.disposed = true;
    },
    write(data: string | Uint8Array) {
      controller.writes.push(data);
    },
    resize(cols: number, rows: number) {
      controller.resizeCalls.push([cols, rows]);
      controller.cols = cols;
      controller.rows = rows;
    },
    reset() {},
    loadAddon(addon: { activate?: (terminal: never) => void }) {
      addon.activate?.(controller as never);
    },
    setViewportPan(enabled: boolean) {
      panCalls.push(enabled);
    },
    setTheme() {},
    getSelection() {
      return '';
    },
  };
  return controller;
}

type FakeController = ReturnType<typeof createFakeController>;

/** 写进终端的都是补过 CR 的字节缓冲，断言前解回字符串。 */
function decodeWrite(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

async function bootWithFake(input: {
  width: number;
  height: number;
  viewportPan: boolean;
  fontSize?: number;
  events?: string[];
  minGrid?: { cols: number; rows: number } | null;
  readMinGrid?: () => { cols: number; rows: number } | null;
  onGridChange?: (cols: number, rows: number) => void;
  fit?: ReturnType<typeof createFakeFit>;
  /** 在「建控制器」那一步执行：模拟异步建面期间外部状态发生变化。 */
  beforeBoot?: () => void;
}) {
  const events = input.events ?? [];
  const mount = createMount(input.width, input.height);
  const fit = input.fit ?? createFakeFit(events);
  const created: FakeController[] = [];
  const session = await bootReadOnlyTerminal({
    mount: mount as unknown as HTMLElement,
    fontId: 'geist-mono',
    fontSize: input.fontSize ?? 13,
    lineHeight: 1.2,
    scrollback: 10000,
    theme: { background: '#111' } as never,
    viewportPan: input.viewportPan,
    minGrid: input.minGrid ?? null,
    readMinGrid: input.readMinGrid,
    onGridChange: input.onGridChange,
    isCancelled: () => false,
    termRef: { current: null },
    themeRef: { current: { background: '#111' } as never },
    loadFonts: async () => {},
    createController: async (options) => {
      input.beforeBoot?.();
      const next = createFakeController(options);
      created.push(next);
      return next as unknown as ReadOnlyController;
    },
    createFitAddon: () => fit,
  });
  const controller = created[0];
  if (!controller) throw new Error('controller not created');
  return { session, controller, mount, events, fit };
}

describe('ReadOnlyTerminal settings and controller options', () => {
  test('reads UI store font/theme and builds disableStdin controller with non-default grid', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `read-only-terminal-${Date.now()}:`,
      host: recordingHost([]),
    });
    runtime.stores.ui.getState().setTerminalFontSize(18);
    runtime.stores.ui.getState().setTerminalLineHeight(1.4);
    const settings = readOnlyTerminalSettingsFromUi(runtime.stores.ui.getState());
    const options = buildReadOnlyControllerOptions({
      fontFamily: resolveFontStack(settings.fontId),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      scrollback: 10000,
      theme: settings.theme,
      mount: { getBoundingClientRect: () => ({ width: 2400, height: 900 }) },
    });
    expect(settings.fontSize).toBe(18);
    expect(settings.lineHeight).toBe(1.4);
    expect(options.disableStdin).toBe(true);
    expect(options.fontSize).toBe(18);
    expect(options.lineHeight).toBe(1.4);
    expect(options.cols).toBeGreaterThan(80);
    expect(options.rows).toBeGreaterThan(24);
    expect(options.scrollback).toBe(10000);
    runtime.dispose();
  });

  test('缩放后的 bounding rect 不参与估列，按 clientWidth 建网格', () => {
    const clientWidth = 2400;
    const clientHeight = 900;
    const options = buildReadOnlyControllerOptions({
      fontFamily: 'monospace',
      fontSize: 18,
      lineHeight: 1.4,
      scrollback: 10000,
      theme: { background: '#000' } as never,
      mount: {
        clientWidth,
        clientHeight,
        getBoundingClientRect: () => ({
          width: clientWidth * 0.95,
          height: clientHeight * 0.95,
        }),
      },
    });
    const fromClient = resolveInitialTerminalGrid({
      rect: { width: clientWidth, height: clientHeight },
      fontSize: 18,
      lineHeight: 1.4,
    });
    const fromScaled = resolveInitialTerminalGrid({
      rect: { width: clientWidth * 0.95, height: clientHeight * 0.95 },
      fontSize: 18,
      lineHeight: 1.4,
    });
    expect(options.cols).toBe(fromClient.cols);
    expect(options.rows).toBe(fromClient.rows);
    expect(fromClient.cols).not.toBe(fromScaled.cols);
  });

  test('测不到容器时仍用 200×24 建面，而不是引擎默认 80×24', () => {
    const options = buildReadOnlyControllerOptions({
      fontFamily: 'monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: { background: '#000' } as never,
      mount: null,
    });
    expect(options.cols).toBe(200);
    expect(options.rows).toBe(24);
    expect(options.disableStdin).toBe(true);
  });
});

describe('unionReadOnlyGrid', () => {
  test('逐轴取大：窗口大就铺满窗口，录像大就按录像来', () => {
    expect(unionReadOnlyGrid({ cols: 200, rows: 50 }, { cols: 52, rows: 47 })).toEqual({
      cols: 200,
      rows: 50,
    });
    expect(unionReadOnlyGrid({ cols: 100, rows: 30 }, { cols: 52, rows: 47 })).toEqual({
      cols: 100,
      rows: 47,
    });
    expect(unionReadOnlyGrid({ cols: 100, rows: 30 }, null)).toEqual({ cols: 100, rows: 30 });
  });
});

describe('ReadOnlyTerminal grid', () => {
  test('零尺寸容器先不建网格，有布局后按容器铺满并打开平移', async () => {
    const { session, controller, mount, fit } = await bootWithFake({
      width: 0,
      height: 0,
      viewportPan: true,
    });
    expect(session).toBeTruthy();
    expect(controller.resizeCalls).toEqual([]);
    expect(controller.panCalls).toEqual([]);
    expect(mountHasPositiveSize(mount)).toBe(false);
    mount.box.width = 640;
    mount.box.height = 352;
    session?.tryFitToContainer();
    expect(controller.resizeCalls).toEqual([[fit.proposal.cols, fit.proposal.rows]]);
    expect(controller.panCalls).toEqual([true]);
    session?.dispose();
  });

  test('开面即按容器铺满；容器变大再 fit 一次，不会被录像尺寸挡住', async () => {
    const fit = createFakeFit([], { cols: 100, rows: 30 });
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
      minGrid: { cols: 52, rows: 47 },
    });
    // 容器 100×30 ∪ 包络 52×47 = 100×47
    expect(controller.resizeCalls).toEqual([[100, 47]]);
    fit.proposal.cols = 220;
    fit.proposal.rows = 60;
    session?.tryFitToContainer();
    expect(controller.resizeCalls).toEqual([
      [100, 47],
      [220, 60],
    ]);
    expect(session?.effectiveGrid).toEqual({ cols: 220, rows: 60 });
    session?.dispose();
  });

  test('包络变大（日志又来一页）立刻重算，网格没变则什么都不做', async () => {
    const fit = createFakeFit([], { cols: 100, rows: 30 });
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
    });
    expect(controller.resizeCalls).toEqual([[100, 30]]);
    session?.setMinGrid({ cols: 52, rows: 47 });
    expect(controller.resizeCalls).toEqual([
      [100, 30],
      [100, 47],
    ]);
    session?.setMinGrid({ cols: 52, rows: 47 });
    session?.tryFitToContainer();
    expect(controller.resizeCalls).toHaveLength(2);
    session?.dispose();
  });

  test('异步建面期间包络又变大：交出 session 前补齐，且不算网格变化', async () => {
    const changes: Array<[number, number]> = [];
    const fit = createFakeFit([], { cols: 100, rows: 30 });
    let envelope = { cols: 52, rows: 24 };
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
      minGrid: envelope,
      // 建面 await 期间日志又来一页，包络涨到 220×50
      readMinGrid: () => envelope,
      onGridChange: (cols, rows) => changes.push([cols, rows]),
      beforeBoot: () => {
        envelope = { cols: 220, rows: 50 };
      },
    });
    expect(session?.effectiveGrid).toEqual({ cols: 220, rows: 50 });
    expect(controller.resizeCalls.at(-1)).toEqual([220, 50]);
    expect(changes).toEqual([]);
    session?.dispose();
  });

  test('网格变化只在开面之后上报，开面那次不算', async () => {
    const changes: Array<[number, number]> = [];
    const fit = createFakeFit([], { cols: 100, rows: 30 });
    const { session } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
      onGridChange: (cols, rows) => changes.push([cols, rows]),
    });
    expect(changes).toEqual([]);
    session?.setMinGrid({ cols: 52, rows: 47 });
    expect(changes).toEqual([[100, 47]]);
    fit.proposal.cols = 120;
    session?.tryFitToContainer();
    expect(changes).toEqual([
      [100, 47],
      [120, 47],
    ]);
    session?.dispose();
  });

  test('写快照：调回录制网格 → 写 → 调回生效网格，且不算网格变化', async () => {
    const changes: Array<[number, number]> = [];
    const fit = createFakeFit([], { cols: 200, rows: 50 });
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
      minGrid: { cols: 80, rows: 24 },
      onGridChange: (cols, rows) => changes.push([cols, rows]),
    });
    expect(controller.resizeCalls).toEqual([[200, 50]]);
    controller.resizeCalls.length = 0;
    session?.handle.writeCheckpoint('SNAP', { cols: 80, rows: 24 });
    expect(controller.resizeCalls).toEqual([
      [80, 24],
      [200, 50],
    ]);
    expect(controller.writes.map(decodeWrite)).toEqual(['SNAP']);
    expect(changes).toEqual([]);
    expect(session?.effectiveGrid).toEqual({ cols: 200, rows: 50 });
    session?.dispose();
  });

  test('录制网格与生效网格相同时不来回 resize', async () => {
    const fit = createFakeFit([], { cols: 80, rows: 24 });
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
    });
    controller.resizeCalls.length = 0;
    session?.handle.writeCheckpoint('SNAP', { cols: 80, rows: 24 });
    expect(controller.resizeCalls).toEqual([]);
    expect(controller.writes.map(decodeWrite)).toEqual(['SNAP']);
    session?.dispose();
  });

  // 裸 LF 补 CR 的状态要跨块接续：块末的 CR 与下一块开头的 LF 是同一个换行，不能再补一个。
  test('CR 跨块接续，reset 之后状态清零', async () => {
    const fit = createFakeFit([], { cols: 100, rows: 30 });
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: false,
      fit,
    });
    const encoder = new TextEncoder();
    session?.handle.write(encoder.encode('abc\r'));
    session?.handle.write(encoder.encode('\ndef'));
    expect(controller.writes.map(decodeWrite)).toEqual(['abc\r', '\ndef']);

    controller.writes.length = 0;
    session?.handle.write(encoder.encode('abc\r'));
    session?.handle.reset();
    session?.handle.write(encoder.encode('\ndef'));
    // reset 清了状态：这个 LF 又是「裸」的，必须补 CR
    expect(controller.writes.map(decodeWrite).at(-1)).toBe('\r\ndef');

    controller.writes.length = 0;
    session?.handle.write(encoder.encode('one\ntwo'));
    expect(controller.writes.map(decodeWrite)).toEqual(['one\r\ntwo']);
    session?.dispose();
  });

  test('reset 清屏后滚回原点：重放的内容要从左上角开始', async () => {
    const fit = createFakeFit([], { cols: 220, rows: 50 });
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      fit,
    });
    controller.viewport.scrollLeft = 120;
    controller.viewport.scrollTop = 40;
    for (const listener of controller.viewport.listeners) listener();
    session?.handle.reset();
    expect(controller.viewport.scrollLeft).toBe(0);
    expect(controller.viewport.scrollTop).toBe(0);
    session?.dispose();
  });

  test('pan 模式下网格变化滚回原点，用户平移后保留偏移', () => {
    const controller = createFakeController({
      theme: { background: '#000' } as GhosttyTerminalInitOptions['theme'],
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
      cols: 200,
      rows: 40,
      disableStdin: true,
    });
    const fit = createFakeFit([], { cols: 120, rows: 40 });
    const session = new ReadOnlyTerminalSession(
      true,
      controller as never,
      fit,
      createMount(300, 200) as unknown as HTMLElement
    );
    session.tryFitToContainer();
    expect(controller.resizeCalls).toEqual([[120, 40]]);
    expect(controller.panCalls).toEqual([true]);
    expect(controller.viewport.scrollLeft).toBe(0);
    expect(controller.viewport.scrollTop).toBe(0);

    controller.viewport.scrollLeft = 80;
    controller.viewport.scrollTop = 12;
    for (const listener of controller.viewport.listeners) listener();
    session.setMinGrid({ cols: 132, rows: 44 });
    expect(controller.viewport.scrollLeft).toBe(80);
    expect(controller.viewport.scrollTop).toBe(12);
    session.setMinGrid({ cols: 140, rows: 48 });
    expect(controller.viewport.scrollLeft).toBe(80);
    expect(controller.viewport.scrollTop).toBe(12);
    session.dispose();
  });

  test('PanOriginPolicy 用户平移后网格变化不再回原点，reset 才清标志', () => {
    const policy = new PanOriginPolicy();
    policy.runProgrammatic(() => policy.onScroll(40, 10));
    expect(policy.shouldResetOrigin()).toBe(true);
    policy.onScroll(40, 10);
    expect(policy.shouldResetOrigin()).toBe(false);
    policy.reset();
    expect(policy.shouldResetOrigin()).toBe(true);
  });
});

describe('schedulePostPaintRefit', () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  function installRAF() {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    return frames;
  }

  function restoreRAF() {
    if (originalRAF) globalThis.requestAnimationFrame = originalRAF;
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }

  test('没有 data-open 祖先时用第二帧 rAF', () => {
    const frames = installRAF();
    try {
      const runs: string[] = [];
      schedulePostPaintRefit({ closest: () => null }, () => runs.push('run'));
      expect(runs).toEqual([]);
      frames[0](0);
      expect(runs).toEqual([]);
      frames[1](0);
      expect(runs).toEqual(['run']);
    } finally {
      restoreRAF();
    }
  });

  test('有正在播放的 data-open 祖先时等 animationend', () => {
    const frames = installRAF();
    try {
      const runs: string[] = [];
      const listeners: Array<() => void> = [];
      const open = {
        addEventListener(_type: string, listener: () => void) {
          listeners.push(listener);
        },
        removeEventListener() {},
        getAnimations: () => [{ playState: 'running' as const }],
      };
      schedulePostPaintRefit({ closest: () => open }, () => runs.push('run'));
      frames[0](0);
      expect(frames.length).toBe(1);
      expect(listeners).toHaveLength(1);
      expect(runs).toEqual([]);
      listeners[0]();
      expect(runs).toEqual(['run']);
    } finally {
      restoreRAF();
    }
  });
});

describe('ReadOnlyTerminal lifecycle', () => {
  test('onReady / onDispose 在字号变化重建时按序发生', async () => {
    const sequence: string[] = [];
    const first = await bootWithFake({ width: 400, height: 200, viewportPan: false, fontSize: 13 });
    sequence.push('ready-13');
    expect(first.controller.options.fontSize).toBe(13);
    expect(first.controller.options.disableStdin).toBe(true);
    expect(first.controller.options.cols).not.toBe(80);
    sequence.push('dispose');
    first.session?.dispose();
    expect(first.controller.disposed).toBe(true);
    const second = await bootWithFake({
      width: 400,
      height: 200,
      viewportPan: false,
      fontSize: 16,
    });
    sequence.push('ready-16');
    expect(second.controller.options.fontSize).toBe(16);
    second.session?.dispose();
    expect(sequence).toEqual(['ready-13', 'dispose', 'ready-16']);
  });
});

describe('ReadOnlyTerminal copy shortcut', () => {
  test('Cmd/Ctrl+C 在有选区时命中', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'MacIntel', userAgent: 'Macintosh' },
      configurable: true,
    });
    expect(isReadOnlyCopyShortcut({ key: 'c', metaKey: true, ctrlKey: false, altKey: false })).toBe(
      true
    );
    expect(isReadOnlyCopyShortcut({ key: 'c', metaKey: false, ctrlKey: true, altKey: false })).toBe(
      false
    );
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
});

describe('ReadOnlyTerminal e2e probe', () => {
  test('写入只读实例与选区，清掉时只动自己挂上的那份', () => {
    const g = globalThis as {
      __vibetermE2eReadOnlyTerminal?: unknown;
      __vibetermE2eReadOnlyTerminalSelectionText?: string | null;
    };
    const first = {
      hasSelection: () => true,
      getSelection: () => 'REPLAY-LEFT-EDGE-1',
    };
    const other = {
      hasSelection: () => false,
      getSelection: () => '',
    };
    setE2eReadOnlyTerminalProbe(first as never);
    expect(g.__vibetermE2eReadOnlyTerminal).toBe(first);
    expect(g.__vibetermE2eReadOnlyTerminalSelectionText).toBe('REPLAY-LEFT-EDGE-1');
    clearE2eReadOnlyTerminalProbe(other as never);
    expect(g.__vibetermE2eReadOnlyTerminal).toBe(first);
    clearE2eReadOnlyTerminalProbe(first as never);
    expect(g.__vibetermE2eReadOnlyTerminal).toBeNull();
    expect(g.__vibetermE2eReadOnlyTerminalSelectionText).toBeNull();
  });
});

describe('ReadOnlyTerminal a11y', () => {
  test('根节点可聚焦并带 region 与 aria-label', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `read-only-a11y-${Date.now()}:`,
      host: recordingHost([]),
    });
    const html = renderToStaticMarkup(
      <RuntimeProvider runtime={runtime}>
        <ReadOnlyTerminal selection ariaLabel="日志回放" />
      </RuntimeProvider>
    );
    expect(html).toContain('<section');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="日志回放"');
    runtime.dispose();
  });
});

describe('ReadOnlyTerminal background', () => {
  // 回放不再画「屏幕外框」：根节点始终是终端底色，内容铺满整块，没有衬底/描边/黑边。
  test('根节点底色恒为终端底色', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `read-only-frame-${Date.now()}:`,
      host: recordingHost([]),
    });
    const background = (html: string): string =>
      /style="background-color:([^"]+)"/.exec(html)?.[1] ?? '';
    const theme = background(
      renderToStaticMarkup(
        <RuntimeProvider runtime={runtime}>
          <ReadOnlyTerminal viewportPan />
        </RuntimeProvider>
      )
    );
    const withMinGrid = background(
      renderToStaticMarkup(
        <RuntimeProvider runtime={runtime}>
          <ReadOnlyTerminal viewportPan minGrid={{ cols: 52, rows: 47 }} />
        </RuntimeProvider>
      )
    );
    expect(theme).not.toBe('');
    expect(withMinGrid).toBe(theme);
    runtime.dispose();
  });
});

describe('ReadOnlyTerminal selection toolbar', () => {
  test('selection 挂上工具条且粘贴关闭', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `read-only-toolbar-${Date.now()}:`,
      host: recordingHost([]),
    });
    const html = renderToStaticMarkup(
      <RuntimeProvider runtime={runtime}>
        <ReadOnlyTerminal selection />
        <ReadOnlySelectionToolbar
          toolbarRef={{ current: null }}
          hasSelection
          showCopyButton
          selectionAnchor={null}
          copySelection={() => {}}
          pasteClipboard={() => {}}
          dismissSelection={() => {}}
        />
      </RuntimeProvider>
    );
    expect(html).toContain('data-testid="read-only-terminal"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-testid="terminal-selection-toolbar"');
    expect(html).toContain('data-testid="terminal-selection-copy"');
    expect(html).not.toContain('data-testid="terminal-selection-paste"');
    runtime.dispose();
  });
});
