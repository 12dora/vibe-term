// 字体加载快路径：同一 fontId:fontSize 只 load 一次，第二次同步返回 undefined，
// 让终端启动不必为已就绪的字体多等一轮微任务。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  areTerminalFontsLoaded,
  ensureTerminalFonts,
  loadTerminalResources,
  resetTerminalFontsCacheForTest,
} from './terminal-fonts-cache';

interface FontsStub {
  loads: string[];
  release: () => void;
}

function installFontsStub(): FontsStub {
  const loads: string[] = [];
  let resolveAll: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    fonts: {
      load: (spec: string) => {
        loads.push(spec);
        return gate.then(() => []);
      },
    },
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };

  return {
    loads,
    release: () => {
      resolveAll?.();
      globals.document = previous;
    },
  };
}

describe('terminal fonts cache', () => {
  let fonts: FontsStub;

  beforeEach(() => {
    resetTerminalFontsCacheForTest();
    fonts = installFontsStub();
  });

  afterEach(() => {
    fonts.release();
    resetTerminalFontsCacheForTest();
  });

  test('shares one in-flight load per font set', () => {
    const first = ensureTerminalFonts('geist-mono', 14);
    const second = ensureTerminalFonts('geist-mono', 14);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(areTerminalFontsLoaded('geist-mono', 14)).toBe(false);
  });

  test('short-circuits synchronously once the font set is loaded', async () => {
    const pending = ensureTerminalFonts('geist-mono', 14);
    fonts.release();
    await pending;

    expect(areTerminalFontsLoaded('geist-mono', 14)).toBe(true);
    expect(ensureTerminalFonts('geist-mono', 14)).toBeUndefined();

    const loadsBefore = fonts.loads.length;
    ensureTerminalFonts('geist-mono', 14);
    expect(fonts.loads).toHaveLength(loadsBefore);
  });

  test('keeps different sizes and font ids apart', async () => {
    const pending = ensureTerminalFonts('geist-mono', 14);
    fonts.release();
    await pending;

    expect(ensureTerminalFonts('geist-mono', 16)).toBeDefined();
    expect(areTerminalFontsLoaded('geist-mono', 16)).toBe(false);
  });
});

// createLifecycleDeps 的 loadResources 就是这个函数（见 useTerminalBootSurface）
describe('loadTerminalResources', () => {
  let fonts: FontsStub;

  beforeEach(() => {
    resetTerminalFontsCacheForTest();
    fonts = installFontsStub();
  });

  afterEach(() => {
    fonts.release();
    resetTerminalFontsCacheForTest();
  });

  test('a cache hit with no host hook resolves synchronously', async () => {
    const warmUp = loadTerminalResources(undefined, 'geist-mono', 14);
    expect(warmUp).toBeDefined();
    fonts.release();
    await warmUp;

    // DeviceConsole 在宿主没挂 prepareTerminalResources 时传的就是返回 undefined 的回调
    expect(loadTerminalResources(undefined, 'geist-mono', 14)).toBeUndefined();
    expect(loadTerminalResources(() => undefined, 'geist-mono', 14)).toBeUndefined();
  });

  test('a host hook that returns a promise still gates the boot', async () => {
    const warmUp = loadTerminalResources(undefined, 'geist-mono', 14);
    fonts.release();
    await warmUp;

    const pending = loadTerminalResources(() => Promise.resolve(), 'geist-mono', 14);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  test('an uncached font set gates the boot even without a host hook', () => {
    expect(loadTerminalResources(undefined, 'geist-mono', 18)).toBeInstanceOf(Promise);
  });
});
