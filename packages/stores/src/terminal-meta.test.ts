// 终端标题的展示层归一：iOS 会把 Emoji_Presentation=No 的图形字符渲染成彩色 emoji，
// 展示路径统一补 U+FE0E；重命名等回写路径必须拿到未归一的原文。

import { describe, expect, test } from 'bun:test';
import { setSiteFallbackReader } from './site-fallback';
import {
  buildBrowserTitle,
  buildTerminalLabel,
  buildWindowDisplayName,
  buildWindowTitleParts,
  forceTextPresentation,
} from './terminal-meta';

const VS15 = '\uFE0E';
const VS16 = '\uFE0F';

describe('forceTextPresentation', () => {
  test('非 emoji 呈现的图形字符补上 U+FE0E', () => {
    expect(forceTextPresentation('✳')).toBe(`✳${VS15}`);
    expect(forceTextPresentation('✴❄⚙')).toBe(`✴${VS15}❄${VS15}⚙${VS15}`);
    expect(forceTextPresentation('✳ Thinking…')).toBe(`✳${VS15} Thinking…`);
  });

  test('已带 U+FE0F 的有意 emoji 序列保持原样', () => {
    const input = `✳${VS16} done`;
    expect(forceTextPresentation(input)).toBe(input);
  });

  test('已带 U+FE0E 的字符不重复追加（幂等）', () => {
    const once = forceTextPresentation('✳');
    expect(forceTextPresentation(once)).toBe(once);
  });

  test('本身就是 emoji 呈现的字符不动', () => {
    expect(forceTextPresentation('🚀')).toBe('🚀');
    expect(forceTextPresentation('🔔 bell')).toBe('🔔 bell');
  });

  test('keycap 序列不动', () => {
    const keycap = `1${VS16}\u20E3`;
    expect(forceTextPresentation(keycap)).toBe(keycap);
  });

  test('纯 ASCII 原样返回', () => {
    expect(forceTextPresentation('bash: ~/code')).toBe('bash: ~/code');
    expect(forceTextPresentation('')).toBe('');
  });

  test('中日文、普通 dingbats（✶✻✽）与常见符号不受影响', () => {
    expect(forceTextPresentation('终端 · window ①')).toBe('终端 · window ①');
    // ✶✻✽ 不是 Extended_Pictographic，iOS 也不会 emoji 化，不应被改写
    expect(forceTextPresentation('✶✻✽')).toBe('✶✻✽');
  });
});

describe('display helpers 应用归一', () => {
  test('buildTerminalLabel 的标题与设备名都归一', () => {
    expect(buildTerminalLabel({ paneTitle: '✳ run', windowName: 'zsh', deviceName: '❄mac' })).toBe(
      `✳${VS15} run@❄${VS15}mac`
    );
  });

  test('buildWindowTitleParts 展示用 title 归一、rawTitle 保持原文', () => {
    const parts = buildWindowTitleParts({
      name: 'node',
      panes: [{ active: true, title: '✳ building' }],
    });
    expect(parts.title).toBe(`✳${VS15} building`);
    expect(parts.rawTitle).toBe('✳ building');
    expect(parts.processName).toBe('node');
  });

  test('buildWindowDisplayName 拼接归一后的进程名与标题', () => {
    expect(
      buildWindowDisplayName({ name: '✳node', panes: [{ active: true, title: 'build' }] })
    ).toBe(`✳${VS15}node: build`);
  });
});

describe('buildBrowserTitle', () => {
  test('无标签时站点名同样归一', () => {
    const restore = setSiteFallbackReader(() => ({ siteName: '✳ tmex' }));
    try {
      expect(buildBrowserTitle(null)).toBe(`✳${VS15} tmex`);
      expect(buildBrowserTitle('   ')).toBe(`✳${VS15} tmex`);
    } finally {
      restore();
    }
  });

  test('带标签时站点名与标签都归一', () => {
    const restore = setSiteFallbackReader(() => ({ siteName: '✳ tmex' }));
    try {
      expect(buildBrowserTitle('✴ vim')).toBe(`[✳${VS15} tmex]✴${VS15} vim`);
    } finally {
      restore();
    }
  });
});
