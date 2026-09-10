// ensureFontFaceInjected：外壳只注入 @font-face、绝不触发 woff2 下载（不调 document.fonts.load）。
// 这是把 2.3 MB 默认字体挪出冷启动关键路径的前提，回归了就等于 useAppMonoFont 又变回旧行为。

import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_FONT_ID, ensureFontFaceInjected, getFontEntry } from './index';

interface FakeStyle {
  dataset: Record<string, string>;
  textContent: string;
}

function installFakeDocument() {
  const appended: FakeStyle[] = [];
  const fontLoads: string[] = [];
  const doc = {
    createElement: (): FakeStyle => ({ dataset: {}, textContent: '' }),
    head: {
      appendChild: (node: FakeStyle) => {
        appended.push(node);
      },
    },
    fonts: {
      load: (spec: string) => {
        fontLoads.push(spec);
        return Promise.resolve([]);
      },
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  return { appended, fontLoads };
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = undefined;
});

describe('ensureFontFaceInjected', () => {
  test('默认字体已在 index.css 静态声明，不再注入', () => {
    const { appended, fontLoads } = installFakeDocument();
    ensureFontFaceInjected(DEFAULT_FONT_ID);
    expect(appended).toHaveLength(0);
    expect(fontLoads).toEqual([]);
  });

  test('非默认字体注入 regular/bold 两条 @font-face，且不触发下载', () => {
    const { appended, fontLoads } = installFakeDocument();
    const nonDefault = getFontEntry('jetbrains-mono');
    ensureFontFaceInjected(nonDefault.id);
    expect(appended).toHaveLength(1);
    const css = appended[0]?.textContent ?? '';
    expect(css).toContain(nonDefault.files?.regular ?? '');
    expect(css).toContain(nonDefault.files?.bold ?? '');
    expect(css).toContain('font-display:swap');
    expect(fontLoads).toEqual([]);
  });

  test('重复调用幂等（同一 family 只注入一次）', () => {
    const { appended } = installFakeDocument();
    ensureFontFaceInjected('fira-code');
    ensureFontFaceInjected('fira-code');
    expect(appended).toHaveLength(1);
  });

  test('未知 fontId 回落到默认字体，不注入', () => {
    const { appended } = installFakeDocument();
    ensureFontFaceInjected('no-such-font');
    expect(appended).toHaveLength(0);
  });

  test('无 document（SSR / 测试宿主）时静默返回', () => {
    (globalThis as { document?: unknown }).document = undefined;
    expect(() => ensureFontFaceInjected('blex-mono')).not.toThrow();
  });
});
