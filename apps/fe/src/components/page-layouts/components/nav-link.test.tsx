// 导航链接的 chunk 预热：悬停/触摸时发一次 import()，原有的事件处理必须原样透传。

import { describe, expect, test } from 'bun:test';
import { withChunkPreload } from './nav-link';

describe('withChunkPreload', () => {
  test('没给 loader 时原样返回处理函数（不多包一层闭包）', () => {
    const handler = () => undefined;
    expect(withChunkPreload(undefined, handler)).toBe(handler);
    expect(withChunkPreload(undefined, undefined)).toBeUndefined();
  });

  test('触发一次预热并把事件透传给原处理函数', () => {
    let loads = 0;
    const seen: string[] = [];
    const wrapped = withChunkPreload(
      () => {
        loads += 1;
        return Promise.resolve();
      },
      (event: string) => void seen.push(event)
    );

    wrapped?.('enter');
    expect(loads).toBe(1);
    expect(seen).toEqual(['enter']);
  });

  test('同一个 loader 反复悬停只发一次请求', () => {
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve();
    };

    const enter = withChunkPreload<string>(load, undefined);
    const touch = withChunkPreload<string>(load, undefined);
    enter?.('enter');
    enter?.('enter');
    touch?.('touch');

    expect(loads).toBe(1);
  });

  test('预热失败静默，不把 rejection 抛给事件处理', () => {
    const wrapped = withChunkPreload<string>(() => Promise.reject(new Error('404')), undefined);
    expect(() => wrapped?.('enter')).not.toThrow();
  });

  test('没有原处理函数时也能单独用', () => {
    let loads = 0;
    const wrapped = withChunkPreload<string>(() => {
      loads += 1;
      return Promise.resolve();
    }, undefined);
    wrapped?.('enter');
    expect(loads).toBe(1);
  });
});
