import { describe, expect, test } from 'bun:test';
import { type ArrowKeyEvent, arrowKeyDirection } from './arrow-keys';

function key(key: string, patch: Partial<ArrowKeyEvent> = {}): ArrowKeyEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: { tagName: 'BODY' },
    ...patch,
  };
}

describe('arrowKeyDirection', () => {
  test('图片 / PDF / 音视频：左键上一个，右键下一个', () => {
    for (const category of ['image', 'pdf', 'audio', 'video'] as const) {
      expect(arrowKeyDirection(key('ArrowLeft'), category)).toBe('prev');
      expect(arrowKeyDirection(key('ArrowRight'), category)).toBe('next');
    }
  });

  test('文本类预览不接管方向键', () => {
    for (const category of ['code', 'markdown', 'text', 'archive'] as const) {
      expect(arrowKeyDirection(key('ArrowLeft'), category)).toBeNull();
    }
  });

  test('带修饰键或其它按键不处理', () => {
    expect(arrowKeyDirection(key('ArrowLeft', { altKey: true }), 'image')).toBeNull();
    expect(arrowKeyDirection(key('ArrowLeft', { ctrlKey: true }), 'image')).toBeNull();
    expect(arrowKeyDirection(key('ArrowRight', { metaKey: true }), 'image')).toBeNull();
    expect(arrowKeyDirection(key('ArrowRight', { shiftKey: true }), 'image')).toBeNull();
    expect(arrowKeyDirection(key('ArrowUp'), 'image')).toBeNull();
    expect(arrowKeyDirection(key('a'), 'image')).toBeNull();
  });

  test('已被别处处理的按键不再处理', () => {
    expect(arrowKeyDirection(key('ArrowLeft', { defaultPrevented: true }), 'image')).toBeNull();
  });

  test('焦点在输入框 / 可编辑区 / 媒体控件上时方向键归它们', () => {
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
      { tagName: 'VIDEO' },
      { tagName: 'AUDIO' },
    ]) {
      expect(arrowKeyDirection(key('ArrowRight', { target }), 'video')).toBeNull();
    }
  });

  test('焦点在按钮或页面上仍切换；没有 target 也不崩', () => {
    expect(arrowKeyDirection(key('ArrowRight', { target: { tagName: 'BUTTON' } }), 'image')).toBe(
      'next'
    );
    expect(arrowKeyDirection(key('ArrowRight', { target: null }), 'image')).toBe('next');
  });
});
