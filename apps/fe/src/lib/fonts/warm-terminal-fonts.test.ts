// 预热只是把终端启动那次加载提前，必须幂等且失败静默——否则空闲预热会变成未捕获 rejection。

import { describe, expect, test } from 'bun:test';
import {
  areTerminalFontsLoaded,
  resetTerminalFontsCacheForTest,
} from '@vibeterm/terminal-ui/components/hooks/terminal-fonts-cache';
import { warmTerminalFonts } from './warm-terminal-fonts';

function withFonts(load: (spec: string) => Promise<unknown>) {
  const previous = (globalThis as { document?: unknown }).document;
  const specs: string[] = [];
  (globalThis as { document?: unknown }).document = {
    fonts: {
      load: (spec: string) => {
        specs.push(spec);
        return load(spec);
      },
    },
  };
  return {
    specs,
    restore: () => {
      (globalThis as { document?: unknown }).document = previous;
    },
  };
}

describe('warmTerminalFonts', () => {
  test('触发一次 document.fonts.load，并把字体集记进缓存', async () => {
    resetTerminalFontsCacheForTest();
    const host = withFonts(() => Promise.resolve([]));
    try {
      warmTerminalFonts({ terminalFontId: 'geist-mono', terminalFontSize: 14 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(host.specs.length).toBeGreaterThan(0);
      expect(areTerminalFontsLoaded('geist-mono', 14)).toBe(true);
    } finally {
      host.restore();
      resetTerminalFontsCacheForTest();
    }
  });

  test('已就绪时不再发起加载（终端启动那次直接命中）', async () => {
    resetTerminalFontsCacheForTest();
    const host = withFonts(() => Promise.resolve([]));
    try {
      warmTerminalFonts({ terminalFontId: 'geist-mono', terminalFontSize: 14 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const first = host.specs.length;
      warmTerminalFonts({ terminalFontId: 'geist-mono', terminalFontSize: 14 });
      expect(host.specs.length).toBe(first);
    } finally {
      host.restore();
      resetTerminalFontsCacheForTest();
    }
  });

  test('加载失败不抛出、不留未处理的 rejection', async () => {
    resetTerminalFontsCacheForTest();
    const host = withFonts(() => Promise.reject(new Error('offline')));
    try {
      expect(() =>
        warmTerminalFonts({ terminalFontId: 'geist-mono', terminalFontSize: 14 })
      ).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      host.restore();
      resetTerminalFontsCacheForTest();
    }
  });
});
