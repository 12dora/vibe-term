// 回放终端的视口配置：录像尺寸远大于 22rem 的回放窗，必须靠平移视口才能看到右下角。
// 无 DOM 测试环境，用结构等价的替身断言调用顺序与副作用。

import { describe, expect, test } from 'bun:test';
import { applyReplayViewport } from './use-replay-terminal';

function fakes() {
  const calls: string[] = [];
  return {
    calls,
    term: {
      panEnabled: false,
      setViewportPan(enabled: boolean) {
        this.panEnabled = enabled;
        calls.push(`pan:${enabled}`);
      },
    },
    fit: {
      fit() {
        calls.push('fit');
      },
    },
  };
}

function mountWith(viewport: { style: { touchAction: string } } | null) {
  return {
    querySelector(selector: string) {
      return selector === '[data-pan-viewport="true"]' ? viewport : null;
    },
  };
}

describe('applyReplayViewport', () => {
  test('先按容器 fit 再开平移视口', () => {
    const { calls, term, fit } = fakes();
    applyReplayViewport(term, fit);
    expect(calls).toEqual(['fit', 'pan:true']);
    expect(term.panEnabled).toBe(true);
  });

  test('把平移容器的 touch-action 交还浏览器', () => {
    const { term, fit } = fakes();
    const viewport = { style: { touchAction: 'none' } };
    applyReplayViewport(term, fit, mountWith(viewport));
    expect(viewport.style.touchAction).toBe('auto');
  });

  test('没有平移容器时照样开平移，不抛错', () => {
    const { calls, term, fit } = fakes();
    expect(() => applyReplayViewport(term, fit, mountWith(null))).not.toThrow();
    expect(() => applyReplayViewport(term, fit, null)).not.toThrow();
    expect(calls).toEqual(['fit', 'pan:true', 'fit', 'pan:true']);
  });
});
