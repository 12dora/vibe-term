// 跟位置（根 + 路径）绑定的局部状态：键一变立刻回到初始值，不会带着上一个目录的状态多渲染一帧。

import { useCallback, useRef, useState } from 'react';

export type KeyedUpdate<T> = T | ((previous: T) => T);

/** 始终指向最近一次渲染的值，让只创建一次的回调读到最新状态。 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function resolveUpdate<T>(update: KeyedUpdate<T>, previous: T): T {
  return typeof update === 'function' ? (update as (previous: T) => T)(previous) : update;
}

/** `initial` 必须是稳定引用（模块常量或原始值）。 */
export function useKeyedState<T>(key: string, initial: T): [T, (update: KeyedUpdate<T>) => void] {
  const [held, setHeld] = useState({ key, value: initial });
  const latest = useLatest({ key, initial });
  const value = held.key === key ? held.value : initial;

  const set = useCallback(
    (update: KeyedUpdate<T>) => {
      setHeld((previous) => {
        const { key: currentKey, initial: fallback } = latest.current;
        const sameKey = previous.key === currentKey;
        const current = sameKey ? previous.value : fallback;
        const next = resolveUpdate(update, current);
        return sameKey && Object.is(next, current) ? previous : { key: currentKey, value: next };
      });
    },
    [latest]
  );

  return [value, set];
}
