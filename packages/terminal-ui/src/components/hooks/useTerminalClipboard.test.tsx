// 桌面 copy mode：button 下选区抬手不得写剪贴板；auto 抬手写一次；触摸长按走同一 commit。
// bun test 无 DOM，react-dom 跑不起来：与仓库其它钩子测一样，用 react-dom/server 执行钩子体，
// 再直接打 pointerup / commitSelectionCopy（桌面抬手与长按结束都进这个函数）。

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AppRuntime, HostServices, TerminalCopyMode } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import * as ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ReactI18nRuntime from 'react-i18next';

installWindowStorage();

type AnyFn = (...args: never[]) => unknown;
const realUseTranslation = ReactI18nRuntime.useTranslation as AnyFn;
const realUseSyncExternalStore = ReactRuntime.useSyncExternalStore;

let hookHostActive = false;

const useSyncExternalStoreForTest: typeof realUseSyncExternalStore = (
  subscribe,
  getSnapshot,
  getServerSnapshot
) =>
  hookHostActive
    ? getSnapshot()
    : realUseSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

mock.module('react', () => {
  const defaultExport = {
    ...(ReactRuntime as unknown as { default?: object }).default,
    ...ReactRuntime,
    useSyncExternalStore: useSyncExternalStoreForTest,
  };
  return {
    ...defaultExport,
    default: defaultExport,
  };
});

mock.module('react-i18next', () => ({
  ...ReactI18nRuntime,
  useTranslation: (...args: unknown[]) =>
    hookHostActive
      ? { t: (key: string) => key, i18n: {}, ready: true }
      : realUseTranslation(...(args as never[])),
}));

const { createAppRuntime } = await import('@vibeterm/stores');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { useTerminalSelectionChrome } = await import('./useTerminalSelectionChrome');

let runtimeSeq = 0;

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function restoreNavigator(): void {
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
}

afterEach(() => {
  hookHostActive = false;
  restoreNavigator();
});

interface FakeTerminal {
  selection: string;
  listeners: Array<(text: string | null) => void>;
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  onSelectionChange(callback: (text: string | null) => void): { dispose(): void };
  paste(text: string): void;
  focus(): void;
  select(text: string): void;
}

function createFakeTerminal(): FakeTerminal {
  const listeners: Array<(text: string | null) => void> = [];
  const terminal: FakeTerminal = {
    selection: '',
    listeners,
    getSelection: () => terminal.selection,
    hasSelection: () => Boolean(terminal.selection),
    clearSelection: () => {
      terminal.selection = '';
      for (const listener of listeners) listener(null);
    },
    onSelectionChange: (callback) => {
      listeners.push(callback);
      return {
        dispose: () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },
    paste: () => {},
    focus: () => {},
    select: (text) => {
      terminal.selection = text;
      for (const listener of listeners) listener(text || null);
    },
  };
  return terminal;
}

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

function mouseUp(): ReactPointerEvent<HTMLDivElement> {
  return { pointerType: 'mouse' } as ReactPointerEvent<HTMLDivElement>;
}

function touchUp(): ReactPointerEvent<HTMLDivElement> {
  return { pointerType: 'touch' } as ReactPointerEvent<HTMLDivElement>;
}

type SelectionChrome = ReturnType<typeof useTerminalSelectionChrome>;

interface MountedChrome {
  chrome: SelectionChrome;
  instance: FakeTerminal;
  writes: string[];
  navWrites: string[];
  runtime: AppRuntime;
  rerender: () => void;
}

function mountChrome(copyMode: TerminalCopyMode): MountedChrome {
  hookHostActive = true;
  const writes: string[] = [];
  const navWrites: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: async (text: string) => {
          navWrites.push(text);
        },
        readText: async () => '',
      },
    },
    configurable: true,
  });

  const instance = createFakeTerminal();
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `terminal-copy-mode-${runtimeSeq++}:`,
    host: recordingHost(writes),
  });
  runtime.stores.ui.getState().setTerminalCopyMode(copyMode);

  const containerRef: RefObject<HTMLElement | null> = { current: null };
  let chrome: SelectionChrome | undefined;

  function Probe() {
    chrome = useTerminalSelectionChrome(
      instance as unknown as CompatibleTerminalLike,
      containerRef
    );
    return null;
  }

  const rerender = () => {
    renderToStaticMarkup(
      <RuntimeProvider runtime={runtime}>
        <Probe />
      </RuntimeProvider>
    );
    if (chrome) mounted.chrome = chrome;
  };
  const mounted: MountedChrome = {
    chrome: undefined as unknown as SelectionChrome,
    instance,
    writes,
    navWrites,
    runtime,
    rerender,
  };
  rerender();
  if (!mounted.chrome) throw new Error('useTerminalSelectionChrome did not render');
  return mounted;
}

function expectNoClipboardWrite(mounted: MountedChrome): void {
  expect(mounted.writes).toEqual([]);
  expect(mounted.navWrites).toEqual([]);
}

describe('desktop copy mode clipboard writes', () => {
  test('button：鼠标划选 + pointerup + selection-change 不写剪贴板', () => {
    const mounted = mountChrome('button');
    mounted.instance.select('ls -la');
    mounted.chrome.handlePointerUp(mouseUp());
    expectNoClipboardWrite(mounted);
    expect(mounted.chrome.showCopyButton).toBe(true);
  });

  test('button：仅 selection-change 不写盘，工具条 copySelection 才写', async () => {
    const mounted = mountChrome('button');
    mounted.instance.select('echo hi');
    expectNoClipboardWrite(mounted);

    mounted.chrome.copySelection();
    await Promise.resolve();
    expect(mounted.writes).toEqual(['echo hi']);
    expect(mounted.navWrites).toEqual([]);
  });

  test('auto：pointerup 写入一次，同一选区再抬手不重复', async () => {
    const mounted = mountChrome('auto');
    expect(mounted.runtime.stores.ui.getState().terminalCopyMode).toBe('auto');
    expect(mounted.chrome.showCopyButton).toBe(false);

    mounted.instance.select('picked');
    mounted.chrome.handlePointerUp(mouseUp());
    await Promise.resolve();
    expect(mounted.writes).toEqual(['picked']);

    mounted.chrome.handlePointerUp(mouseUp());
    await Promise.resolve();
    expect(mounted.writes).toEqual(['picked']);
  });

  test('auto：touch pointerup 不走桌面抬手（交给长按 commit）', async () => {
    const mounted = mountChrome('auto');
    mounted.instance.select('from-touch-pointer');
    mounted.chrome.handlePointerUp(touchUp());
    await Promise.resolve();
    expectNoClipboardWrite(mounted);
  });

  test('button：触摸长按结束走 commitSelectionCopy 仍不写盘', async () => {
    const mounted = mountChrome('button');
    mounted.instance.select('long-press');
    mounted.chrome.commitSelectionCopy();
    await Promise.resolve();
    expectNoClipboardWrite(mounted);
  });

  test('auto：触摸长按结束走 commitSelectionCopy 写一次', async () => {
    const mounted = mountChrome('auto');
    mounted.instance.select('long-press');
    mounted.chrome.commitSelectionCopy();
    await Promise.resolve();
    expect(mounted.writes).toEqual(['long-press']);
  });
});

describe('copyMode 与 store 实例', () => {
  test('设置面板写入的 store 就是钩子读到的那份', () => {
    const mounted = mountChrome('button');
    expect(mounted.runtime.stores.ui.getState().terminalCopyMode).toBe('button');
    mounted.runtime.stores.ui.getState().setTerminalCopyMode('auto');
    mounted.rerender();
    expect(mounted.chrome.showCopyButton).toBe(false);

    mounted.instance.select('after-switch');
    mounted.chrome.handlePointerUp(mouseUp());
    expect(mounted.writes).toEqual(['after-switch']);
  });
});
