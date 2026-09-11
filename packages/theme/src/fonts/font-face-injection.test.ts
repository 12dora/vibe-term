// ensureFontFaceInjected：外壳只注入 @font-face、绝不触发 woff2 下载（不调 document.fonts.load）。
// 这是把 2.3 MB 默认字体挪出冷启动关键路径的前提，回归了就等于 useAppMonoFont 又变回旧行为。

import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_FONT_ID,
  FIRST_PAINT_SAMPLE_TEXT,
  ensureFontFaceInjected,
  getFontEntry,
  loadTerminalFontStages,
  loadTerminalFonts,
  sampleTextForRange,
} from './index';

interface FakeStyle {
  dataset: Record<string, string>;
  textContent: string;
}

function installFakeDocument(options: { fail?: boolean } = {}) {
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
      // 样本文本也记进来：两段加载的差别全在「用什么文本触发哪一个 face」
      load: (spec: string, text?: string) => {
        fontLoads.push(text === undefined ? spec : `${spec}|${text}`);
        return options.fail ? Promise.reject(new Error('font load failed')) : Promise.resolve([]);
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

describe('loadTerminalFontStages', () => {
  test('默认字体：ready 只等子集样本，完整文件与符号兜底进 upgrade', async () => {
    const { fontLoads } = installFakeDocument();
    const subset = getFontEntry(DEFAULT_FONT_ID).subset;
    if (!subset) throw new Error('默认字体缺少 subset');
    const fullSample = sampleTextForRange(subset.fullUnicodeRange) as string;

    const stages = loadTerminalFontStages(DEFAULT_FONT_ID, 14);
    await stages.ready;

    // ready 那一段只碰主字体的两字重，且样本是首帧文本（落在子集 unicode-range 内）；
    // 二段在 startUpgrade 之前一个请求都不该发。
    expect(fontLoads).toEqual([
      `14px GeistMonoVibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
      `bold 14px GeistMonoVibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
    ]);

    expect(stages.startUpgrade).not.toBeNull();
    await (stages.startUpgrade as () => Promise<void>)();
    const upgradeLoads = fontLoads.slice(2);
    expect(upgradeLoads).toEqual([
      `14px NotoSansSymbols2VibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
      `bold 14px NotoSansSymbols2VibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
      `14px GeistMonoVibeTerm|${fullSample}`,
      `bold 14px GeistMonoVibeTerm|${fullSample}`,
    ]);
  });

  test('非默认字体没有子集：ready 就是整份，upgrade 只剩符号兜底', async () => {
    const { appended, fontLoads } = installFakeDocument();
    const stages = loadTerminalFontStages('victor-mono', 16);
    await stages.ready;
    await (stages.startUpgrade as () => Promise<void>)();

    expect(appended).toHaveLength(1); // 非默认字体仍然运行时注入 @font-face
    expect(fontLoads).toEqual([
      `16px VictorMonoVibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
      `bold 16px VictorMonoVibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
      `16px NotoSansSymbols2VibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
      `bold 16px NotoSansSymbols2VibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`,
    ]);
  });

  test('单个 face 加载失败不会让 ready / upgrade reject（降级到系统等宽即可）', async () => {
    installFakeDocument({ fail: true });
    const stages = loadTerminalFontStages(DEFAULT_FONT_ID, 14);
    await expect(stages.ready).resolves.toBeUndefined();
    await expect((stages.startUpgrade as () => Promise<void>)()).resolves.toBeUndefined();
  });

  test('无 document 时两段都是空操作', () => {
    (globalThis as { document?: unknown }).document = undefined;
    const stages = loadTerminalFontStages(DEFAULT_FONT_ID, 14);
    expect(stages.startUpgrade).toBeNull();
  });
});

describe('loadTerminalFonts', () => {
  test('两段都等：预览 / 分享回放用 canvas 画，缺了 Nerd 图标那一段就一直是兜底字形', async () => {
    const { fontLoads } = installFakeDocument();
    await loadTerminalFonts(DEFAULT_FONT_ID, 14);
    const subset = getFontEntry(DEFAULT_FONT_ID).subset;
    if (!subset) throw new Error('默认字体缺少 subset');
    const fullSample = sampleTextForRange(subset.fullUnicodeRange) as string;
    expect(fontLoads).toHaveLength(6);
    expect(fontLoads).toContain(`14px GeistMonoVibeTerm|${fullSample}`);
    expect(fontLoads).toContain(`14px NotoSansSymbols2VibeTerm|${FIRST_PAINT_SAMPLE_TEXT}`);
  });
});
