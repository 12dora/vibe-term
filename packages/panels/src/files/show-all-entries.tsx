// 目录节点「展开显示上限之外的条目」这一位状态，提到根节点之上保存。
//
// 拖拽实现（`device-tree-dnd`）是按需 import 的：chunk 落地那一刻 `SortableVerticalList`
// 从空壳分支换成 `DndContext + SortableContext`，children 在树里的位置变了，React 必然重挂
// 整棵文件树。放在 `DirNode` 自身的 `useState` 里，用户在 chunk 落地前点过的「显示全部」
// 会被这次重挂清零，超过上限的条目当场消失——慢链路 + 大目录下这是能复现的。
//
// 状态提到 `SortableVerticalList` 之上就不会被那次重挂波及。发布方式与 `selected-file`
// 一致：外部 store + 逐节点按自己那一位布尔订阅，改一个节点不会惊动其余目录。

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';

export interface ShowAllStore {
  has: (nodeKey: string) => boolean;
  show: (nodeKey: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createShowAllStore(): ShowAllStore {
  const shown = new Set<string>();
  const listeners = new Set<() => void>();
  return {
    has: (nodeKey) => shown.has(nodeKey),
    show: (nodeKey) => {
      if (shown.has(nodeKey)) return;
      shown.add(nodeKey);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const ShowAllContext = createContext<ShowAllStore | null>(null);

export function ShowAllEntriesProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createShowAllStore);
  return <ShowAllContext.Provider value={store}>{children}</ShowAllContext.Provider>;
}

export interface ShowAllEntries {
  showAll: boolean;
  show: () => void;
}

function useShowAllStore(): ShowAllStore {
  const store = useContext(ShowAllContext);
  if (!store) {
    throw new Error('useShowAllEntries must be used within a ShowAllEntriesProvider.');
  }
  return store;
}

/** 该目录是否已被要求显示全部条目，以及把它置真的动作 */
export function useShowAllEntries(nodeKey: string): ShowAllEntries {
  const store = useShowAllStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.has(nodeKey), [store, nodeKey]);
  const showAll = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const show = useCallback(() => store.show(nodeKey), [store, nodeKey]);
  return { showAll, show };
}
