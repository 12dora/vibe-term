import { describe, expect, test } from 'bun:test';
import {
  EMPTY_PANE_MODE_FLAGS,
  PANE_MODE_MOUSE_BUTTON,
  PANE_MODE_MOUSE_SGR,
  decodePaneModes,
  encodePaneModes,
} from './pane-modes';

describe('pane-modes bitfield', () => {
  test('空 flags 编码为 0', () => {
    expect(encodePaneModes(EMPTY_PANE_MODE_FLAGS)).toBe(0);
    expect(decodePaneModes(0)).toEqual(EMPTY_PANE_MODE_FLAGS);
  });

  test('1002+1006（opencode 拖拽场景）往返', () => {
    const flags = {
      mouseStandard: false,
      mouseButton: true,
      mouseAll: false,
      mouseSgr: true,
      mouseUtf8: false,
    };
    const bits = encodePaneModes(flags);
    expect(bits).toBe(PANE_MODE_MOUSE_BUTTON | PANE_MODE_MOUSE_SGR);
    expect(decodePaneModes(bits)).toEqual(flags);
  });

  test('全开往返且落在 u8 范围内', () => {
    const flags = {
      mouseStandard: true,
      mouseButton: true,
      mouseAll: true,
      mouseSgr: true,
      mouseUtf8: true,
    };
    const bits = encodePaneModes(flags);
    expect(bits).toBeLessThan(256);
    expect(decodePaneModes(bits)).toEqual(flags);
  });
});
