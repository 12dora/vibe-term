// 文件树的「当前选中文件」：一次读路由，逐节点按需订阅。
//
// 直接在每个目录/文件行里调 `useLocation()` 的话，React Router 每次导航都会发布一个新的
// location 对象，于是切一次 tmux pane（路由里带 device/window/pane）就重渲染整棵已挂载的
// 文件树——单目录最多 500 行，每行还带一整个右键菜单子树，`memo` 完全失效。
//
// 这里把路由读取收在 provider 一处，选中态经一个稳定的外部 store 发布；行组件用
// `useSyncExternalStore` 订阅**自己那一位布尔**，只有真正从选中变未选中（或反之）的那两行
// 才会重渲染。provider 的 context value 是 store 本身（恒等），不会因为选中态变化而让
// 所有消费者跟着重渲染。

import { decodeFileRef, hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { matchPath, useLocation } from 'react-router';

export interface SelectedFile {
  rootId: string;
  path: string;
}

interface SelectedFileStore {
  get: () => SelectedFile | null;
  set: (next: SelectedFile | null) => void;
  notify: () => void;
  subscribe: (listener: () => void) => () => void;
}

function createSelectedFileStore(): SelectedFileStore {
  let current: SelectedFile | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
    notify: () => {
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

/** 该行是否被选中；行组件按这一位布尔订阅，路由变化时未受影响的行读到同值直接 bail */
export function isFileSelected(
  selected: SelectedFile | null,
  rootId: string,
  path: string
): boolean {
  return selected !== null && selected.rootId === rootId && selected.path === path;
}

/** 选中文件落在该根下时给出它的路径，否则 null */
export function selectedPathInRoot(selected: SelectedFile | null, rootId: string): string | null {
  return selected !== null && selected.rootId === rootId ? selected.path : null;
}

/** 去掉目录路径末尾多余的分隔符（保留根 `/` 本身），便于与父目录逐字比较 */
function dirKey(dir: string): string {
  let end = dir.length;
  while (end > 1 && dir[end - 1] === '/') end -= 1;
  return dir.slice(0, end);
}

/**
 * 选中文件是该目录的**直接子项**时给出它的路径，否则 null。
 *
 * 目录节点只用这一个值撑开显示上限（`entries` 就是直接子项，别处的选中文件永远 findIndex
 * 不到），所以按「整根的选中路径」订阅是过量的：同一个根下换文件会让这个根里所有已挂载的
 * 目录节点快照都变一遍。按直接子项派生后，只有真正得失一个选中子项的那一两个目录会重渲染。
 */
export function selectedChildPath(
  selected: SelectedFile | null,
  rootId: string,
  dirPath: string
): string | null {
  const path = selectedPathInRoot(selected, rootId);
  if (path === null) return null;
  const cut = path.lastIndexOf('/');
  const parent = cut < 0 ? '' : cut === 0 ? '/' : path.slice(0, cut);
  return parent === dirKey(dirPath) ? path : null;
}

const SelectedFileContext = createContext<SelectedFileStore | null>(null);

function useSelectedFileStore(): SelectedFileStore {
  const store = useContext(SelectedFileContext);
  if (!store) {
    throw new Error('useSelectedFile* must be used within a SelectedFileProvider.');
  }
  return store;
}

function useSelectedFilePath(): SelectedFile | null {
  const location = useLocation();
  const { host } = useRuntime();
  return useMemo(() => {
    const match = matchPath(hostAppPath(host, '/file/:ref'), location.pathname);
    if (!match?.params.ref) return null;
    return decodeFileRef(match.params.ref);
  }, [location.pathname, host]);
}

export function SelectedFileProvider({ children }: { children: ReactNode }) {
  const selected = useSelectedFilePath();
  const [store] = useState(createSelectedFileStore);

  // 渲染期同步快照：本帧新挂载的行必须读到当前选中态；已挂载的行由下面的 effect 唤醒。
  store.set(selected);
  useEffect(() => {
    store.set(selected);
    store.notify();
  }, [selected, store]);

  return <SelectedFileContext.Provider value={store}>{children}</SelectedFileContext.Provider>;
}

/** 该文件行是否是当前选中的那一行 */
export function useIsFileSelected(rootId: string, path: string): boolean {
  const store = useSelectedFileStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(
    () => isFileSelected(store.get(), rootId, path),
    [store, rootId, path]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 选中文件是该目录的直接子项时给出它的路径，否则 null（目录节点据此撑开显示上限） */
export function useSelectedChildPath(rootId: string, dirPath: string): string | null {
  const store = useSelectedFileStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(
    () => selectedChildPath(store.get(), rootId, dirPath),
    [store, rootId, dirPath]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
