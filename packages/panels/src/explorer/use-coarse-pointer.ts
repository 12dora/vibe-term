// 主指针是否为触屏。只看主指针：带触摸屏的笔记本接着鼠标时仍按鼠标交互（双击打开、可拖拽、可框选）。

import { useSyncExternalStore } from 'react';

const COARSE_QUERY = '(pointer: coarse)';

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(COARSE_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery()?.matches ?? false,
    () => false
  );
}
