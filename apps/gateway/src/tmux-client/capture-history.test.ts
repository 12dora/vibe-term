import { describe, expect, test } from 'bun:test';
import type { PaneModeFlags } from '@tmex/shared';
import { appendCursorRestore, parsePaneScreenInfo } from './capture-history';

const NO_MODES: PaneModeFlags = {
  mouseStandard: false,
  mouseButton: false,
  mouseAll: false,
  mouseSgr: false,
  mouseUtf8: false,
};

describe('parsePaneScreenInfo', () => {
  test('解析 display-message 输出（含鼠标模式 flags）', () => {
    expect(parsePaneScreenInfo('1 8 3 40 0 1 0 1 0\n')).toEqual({
      alternateScreen: true,
      cursorX: 8,
      cursorY: 3,
      paneHeight: 40,
      modes: {
        mouseStandard: false,
        mouseButton: true,
        mouseAll: false,
        mouseSgr: true,
        mouseUtf8: false,
      },
    });
  });

  test('主屏输出 alternate_on=0、无鼠标模式', () => {
    expect(parsePaneScreenInfo('0 0 39 40 0 0 0 0 0\n')).toEqual({
      alternateScreen: false,
      cursorX: 0,
      cursorY: 39,
      paneHeight: 40,
      modes: NO_MODES,
    });
  });

  test('1003 any-motion 与 utf8 编码 flags', () => {
    expect(parsePaneScreenInfo('1 0 0 24 0 0 1 0 1\n').modes).toEqual({
      mouseStandard: false,
      mouseButton: false,
      mouseAll: true,
      mouseSgr: false,
      mouseUtf8: true,
    });
  });

  test('字段缺失或非数字时返回 null 字段、模式回退关闭', () => {
    expect(parsePaneScreenInfo('0\n')).toEqual({
      alternateScreen: false,
      cursorX: null,
      cursorY: null,
      paneHeight: null,
      modes: NO_MODES,
    });
    expect(parsePaneScreenInfo('')).toEqual({
      alternateScreen: false,
      cursorX: null,
      cursorY: null,
      paneHeight: null,
      modes: NO_MODES,
    });
    expect(parsePaneScreenInfo('0 x y z\n').cursorX).toBeNull();
  });
});

describe('appendCursorRestore', () => {
  test('主屏：从可见区域底行相对上移到光标行并定位列', () => {
    const history = 'line1\nline2\nline3\n';
    const restored = appendCursorRestore(history, {
      alternateScreen: false,
      cursorX: 4,
      cursorY: 1,
      paneHeight: 3,
      modes: NO_MODES,
    });
    expect(restored).toBe('line1\nline2\nline3\x1b[1A\x1b[5G');
  });

  test('主屏：光标在底行时只定位列', () => {
    const restored = appendCursorRestore('a\nb\n', {
      alternateScreen: false,
      cursorX: 0,
      cursorY: 1,
      paneHeight: 2,
      modes: NO_MODES,
    });
    expect(restored).toBe('a\nb\x1b[1G');
  });

  test('alt 屏：绝对定位', () => {
    const restored = appendCursorRestore('TUI SCREEN\n', {
      alternateScreen: true,
      cursorX: 8,
      cursorY: 3,
      paneHeight: 40,
      modes: NO_MODES,
    });
    expect(restored).toBe('TUI SCREEN\x1b[4;9H');
  });

  test('光标信息缺失时保持原数据（含结尾换行）', () => {
    const history = 'line1\nline2\n';
    expect(
      appendCursorRestore(history, {
        alternateScreen: false,
        cursorX: null,
        cursorY: null,
        paneHeight: null,
        modes: NO_MODES,
      })
    ).toBe(history);
  });

  test('输入不以换行结尾时不额外裁剪', () => {
    const restored = appendCursorRestore('abc', {
      alternateScreen: false,
      cursorX: 2,
      cursorY: 0,
      paneHeight: 1,
      modes: NO_MODES,
    });
    expect(restored).toBe('abc\x1b[3G');
  });

  test('cursorY 越界时上移量被钳制在屏幕高度内', () => {
    const restored = appendCursorRestore('a\n', {
      alternateScreen: false,
      cursorX: 0,
      cursorY: 0,
      paneHeight: 100,
      modes: NO_MODES,
    });
    expect(restored).toBe('a\x1b[99A\x1b[1G');
  });
});
