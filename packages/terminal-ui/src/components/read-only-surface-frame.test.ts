// 「屏幕」外框：开了才写样式（衬底 + 描边 + 居中），关了把元素还原成纯终端底色。

import { describe, expect, test } from 'bun:test';
import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT } from '@vibeterm/shared';
import {
  applyReadOnlySurfaceFrame,
  readOnlySurfaceBackdrop,
  readOnlySurfaceOutline,
} from './hooks/read-only-surface-frame';

type FakeStyle = Record<string, string>;

function fakeElement(): { style: FakeStyle } {
  return {
    style: { backgroundColor: '', display: '', margin: '', flex: '', outline: '' },
  };
}

function fakeTree() {
  const root = fakeElement();
  const viewport = fakeElement();
  const screen = fakeElement();
  const host = {
    ...root,
    querySelector(selector: string) {
      if (selector === '.xterm-viewport') return viewport;
      if (selector === '.xterm-screen') return screen;
      return null;
    },
  };
  return { host: host as unknown as HTMLElement, root: host, viewport, screen };
}

describe('readOnlySurfaceBackdrop', () => {
  test('深色底色朝黑里混，浅色底色也压暗，两边都与终端底色不同', () => {
    const dark = readOnlySurfaceBackdrop(TERMINAL_THEME_DARK);
    const light = readOnlySurfaceBackdrop(TERMINAL_THEME_LIGHT);
    expect(dark).not.toBe(TERMINAL_THEME_DARK.background);
    expect(light).not.toBe(TERMINAL_THEME_LIGHT.background);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('近黑底色改为提亮，不会黑到黑上看不出边界', () => {
    const backdrop = readOnlySurfaceBackdrop({
      ...TERMINAL_THEME_DARK,
      background: '#000000',
    });
    expect(backdrop).not.toBe('#000000');
    expect(Number.parseInt(backdrop.slice(1), 16)).toBeGreaterThan(0);
  });

  test('认不出的颜色退回半透明黑，不抛错', () => {
    const theme = { ...TERMINAL_THEME_DARK, background: 'var(--background)' };
    expect(readOnlySurfaceBackdrop(theme)).toBe('rgba(0, 0, 0, 0.35)');
    expect(readOnlySurfaceOutline({ ...theme, foreground: 'var(--foreground)' })).toBe(
      'rgba(128, 128, 128, 0.7)'
    );
  });
});

describe('applyReadOnlySurfaceFrame', () => {
  test('开启时 root 走衬底、内容表面保留终端底色并描边居中', () => {
    const tree = fakeTree();
    applyReadOnlySurfaceFrame(tree.host, TERMINAL_THEME_DARK, true);
    expect(tree.root.style.backgroundColor).toBe(readOnlySurfaceBackdrop(TERMINAL_THEME_DARK));
    expect(tree.root.style.backgroundColor).not.toBe(TERMINAL_THEME_DARK.background);
    expect(tree.viewport.style.display).toBe('flex');
    expect(tree.viewport.style.backgroundColor).toBe('transparent');
    expect(tree.screen.style.backgroundColor).toBe(TERMINAL_THEME_DARK.background);
    expect(tree.screen.style.margin).toBe('auto');
    expect(tree.screen.style.flex).toBe('none');
    expect(tree.screen.style.outline).toBe(
      `1px solid ${readOnlySurfaceOutline(TERMINAL_THEME_DARK)}`
    );
  });

  test('关闭时不留外框样式，底色全是终端底色', () => {
    const tree = fakeTree();
    applyReadOnlySurfaceFrame(tree.host, TERMINAL_THEME_LIGHT, true);
    applyReadOnlySurfaceFrame(tree.host, TERMINAL_THEME_LIGHT, false);
    expect(tree.root.style.backgroundColor).toBe(TERMINAL_THEME_LIGHT.background);
    expect(tree.screen.style.backgroundColor).toBe(TERMINAL_THEME_LIGHT.background);
    expect(tree.viewport.style.display).toBe('');
    expect(tree.viewport.style.backgroundColor).toBe('');
    expect(tree.screen.style.margin).toBe('');
    expect(tree.screen.style.flex).toBe('');
    expect(tree.screen.style.outline).toBe('');
  });

  test('元素树还没建好时安静返回', () => {
    expect(() => applyReadOnlySurfaceFrame(null, TERMINAL_THEME_DARK, true)).not.toThrow();
    const bare = { style: {}, querySelector: () => null } as unknown as HTMLElement;
    expect(() => applyReadOnlySurfaceFrame(bare, TERMINAL_THEME_DARK, true)).not.toThrow();
  });
});
