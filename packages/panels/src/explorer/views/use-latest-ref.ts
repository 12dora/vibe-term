import { useRef } from 'react';

/** 始终指向最近一次渲染的值，让只创建一次的事件处理函数读到最新的 props。 */
export function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
