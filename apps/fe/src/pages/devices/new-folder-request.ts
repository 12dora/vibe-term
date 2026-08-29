// 顶栏「新建文件夹」按钮的目标注册表。
//
// 与 `add-device-targets` 同一个理由：顶栏（PageActions）与页面主体（DevicesPage）挂在
// 两棵互不相连的子树里，没法用 context 把树的 ref 递上去。页面主体挂载时登记一个回调，
// 顶栏用 useSyncExternalStore 订阅；没人登记（页面没挂载）时顶栏不显示这个按钮。

import { useSyncExternalStore } from 'react';

export type NewFolderRequest = () => void;

let current: NewFolderRequest | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** 登记页面主体的「在根层新建文件夹」回调，返回注销函数。 */
export function registerNewFolderRequest(request: NewFolderRequest): () => void {
  current = request;
  publish();
  return () => {
    if (current !== request) return;
    current = null;
    publish();
  };
}

export function getNewFolderRequest(): NewFolderRequest | null {
  return current;
}

export function subscribeNewFolderRequest(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function resetNewFolderRequestForTest(): void {
  current = null;
  listeners.clear();
}

export function useNewFolderRequest(): NewFolderRequest | null {
  return useSyncExternalStore(subscribeNewFolderRequest, getNewFolderRequest, getNewFolderRequest);
}
