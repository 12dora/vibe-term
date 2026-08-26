import { type RefObject, useEffect, useRef } from 'react';

/** 把随渲染变化的值镜像进 ref，供异步回调（终端事件、await 之后）读取最新值 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
