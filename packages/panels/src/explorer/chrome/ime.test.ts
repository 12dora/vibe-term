import { describe, expect, test } from 'bun:test';
import { isImeKeyEvent } from './ime';

describe('isImeKeyEvent', () => {
  test('普通按键不算组合态', () => {
    expect(isImeKeyEvent({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(
      false
    );
    expect(isImeKeyEvent({})).toBe(false);
  });

  test('React 合成事件：看 nativeEvent.isComposing', () => {
    expect(isImeKeyEvent({ keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(
      true
    );
  });

  test('keyCode 229 视为组合态（合成事件或原生事件上都算）', () => {
    expect(isImeKeyEvent({ keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isImeKeyEvent({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
  });

  test('原生事件：直接看 isComposing / keyCode', () => {
    expect(isImeKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 27 })).toBe(false);
  });
});
