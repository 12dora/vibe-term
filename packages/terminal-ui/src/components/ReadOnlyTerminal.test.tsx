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
  fitThenEnablePan,
  isReadOnlyCopyShortcut,
  mountHasPositiveSize,
  readOnlyTerminalSettingsFromUi,
} = await import('./hooks/read-only-terminal-session');
type ReadOnlyController = import('./hooks/read-only-terminal-session').ReadOnlyController;
const { ReadOnlySelectionToolbar, ReadOnlyTerminal } = await import('./ReadOnlyTerminal');
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
  };
}

function createFakeFit(events: string[] = []) {
  return {
    events,
    fit() {
      events.push('fit');
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

async function bootWithFake(input: {
  width: number;
  height: number;
  viewportPan: boolean;
  fontSize?: number;
  events?: string[];
}) {
  const events = input.events ?? [];
  const mount = createMount(input.width, input.height);
  const created: FakeController[] = [];
  const session = await bootReadOnlyTerminal({
    mount: mount as unknown as HTMLElement,
    fontId: 'geist-mono',
    fontSize: input.fontSize ?? 13,
    lineHeight: 1.2,
    scrollback: 10000,
    theme: { background: '#111' } as never,
    viewportPan: input.viewportPan,
    isCancelled: () => false,
    termRef: { current: null },
    themeRef: { current: { background: '#111' } as never },
    loadFonts: async () => {},
    createController: async (options) => {
      const next = createFakeController(options);
      created.push(next);
      return next as unknown as ReadOnlyController;
    },
    createFitAddon: () => createFakeFit(events),
  });
  const controller = created[0];
  if (!controller) throw new Error('controller not created');
  return { session, controller, mount, events };
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

describe('ReadOnlyTerminal viewport pan', () => {
  test('viewportPan 先 fit 再 setViewportPan(true)', () => {
    const events: string[] = [];
    fitThenEnablePan(
      {
        setViewportPan(enabled) {
          events.push(`pan:${enabled}`);
        },
      },
      {
        fit() {
          events.push('fit');
        },
      }
    );
    expect(events).toEqual(['fit', 'pan:true']);
  });

  test('零尺寸容器跳过首次 fit，有布局后再 fit+pan', async () => {
    const events: string[] = [];
    const { session, controller, mount } = await bootWithFake({
      width: 0,
      height: 0,
      viewportPan: true,
      events,
    });
    expect(session).toBeTruthy();
    expect(events).toEqual([]);
    expect(controller.panCalls).toEqual([]);
    expect(mountHasPositiveSize(mount)).toBe(false);
    mount.box.width = 640;
    mount.box.height = 352;
    session?.tryFitToContainer();
    expect(events).toEqual(['fit']);
    expect(controller.panCalls).toEqual([true]);
    session?.dispose();
  });

  test('boot 在有布局且 viewportPan 时 fit 后打开平移', async () => {
    const events: string[] = [];
    const { session, controller } = await bootWithFake({
      width: 640,
      height: 352,
      viewportPan: true,
      events,
    });
    expect(events).toEqual(['fit']);
    expect(controller.panCalls).toEqual([true]);
    session?.dispose();
  });

  test('pan 模式下 resize 滚回原点，用户平移后保留偏移', () => {
    const events: string[] = [];
    const controller = createFakeController({
      theme: { background: '#000' } as GhosttyTerminalInitOptions['theme'],
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
      cols: 200,
      rows: 40,
      disableStdin: true,
    });
    const session = new ReadOnlyTerminalSession(
      true,
      controller as never,
      createFakeFit(events),
      createMount(300, 200) as unknown as HTMLElement
    );
    session.handle.resize(120, 40);
    expect(controller.resizeCalls).toEqual([[120, 40]]);
    expect(controller.panCalls).toEqual([true]);
    expect(controller.viewport.scrollLeft).toBe(0);
    expect(controller.viewport.scrollTop).toBe(0);

    controller.viewport.scrollLeft = 80;
    controller.viewport.scrollTop = 12;
    for (const listener of controller.viewport.listeners) listener();
    session.handle.resize(132, 44);
    expect(controller.viewport.scrollLeft).toBe(80);
    expect(controller.viewport.scrollTop).toBe(12);
    session.dispose();
  });

  test('PanOriginPolicy 在编程滚动时不计为用户平移', () => {
    const policy = new PanOriginPolicy();
    policy.runProgrammatic(() => policy.onScroll(40, 10));
    expect(policy.shouldResetOrigin()).toBe(true);
    policy.onScroll(40, 10);
    expect(policy.shouldResetOrigin()).toBe(false);
    policy.noteResizeConsumed();
    expect(policy.shouldResetOrigin()).toBe(true);
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
    expect(html).toContain('data-testid="terminal-selection-toolbar"');
    expect(html).toContain('data-testid="terminal-selection-copy"');
    expect(html).not.toContain('data-testid="terminal-selection-paste"');
    runtime.dispose();
  });
});
