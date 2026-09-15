// 按 nodeId 读该 node 运行时的 tmux store，不依赖 `RuntimeProvider`：头部徽标以 nodeId 为准，
// 页面区之外（以及服务端渲染）也能取到同一份值。
// 选择器只取标量或 store 内稳定的对象引用，`useSyncExternalStore` 才不会每帧判定为变更。

import type { TmuxState } from '@vibeterm/stores/tmux-state';
import { useMemo, useSyncExternalStore } from 'react';
import { appNodeRuntimes } from './node-runtimes';

export interface TmuxStateReader {
  subscribe: (listener: () => void) => () => void;
  getState: () => TmuxState;
}

export function useTmuxSlice<T>(store: TmuxStateReader, select: (state: TmuxState) => T): T {
  const read = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, read, read);
}

export function useNodeTmuxStore(nodeId: string): TmuxStateReader {
  return useMemo<TmuxStateReader>(() => appNodeRuntimes.get(nodeId).runtime.stores.tmux, [nodeId]);
}
