// 跟位置（根 + 路径）绑定的局部状态：键一变立刻回到初始值，不会带着上一个目录的状态多渲染一帧；
// 旧键的值同时被丢弃——之后再回到那个键，拿到的也是初始值。

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
  const stale = held.key !== key;
  // 渲染期间校正：真正把存着的旧值换掉，而不只是这一帧不读它
  if (stale) setHeld({ key, value: initial });
  const value = stale ? initial : held.value;

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
