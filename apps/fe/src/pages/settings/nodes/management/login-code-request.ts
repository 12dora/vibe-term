// 「登录命令」对话框的打开请求：卡头按钮、行内菜单与批量菜单各自发请求，由应用外壳里唯一一份
// `LoginCodeDialogHost`（`login-code-host.tsx`）接收，免得把开关一路传进表格与卡片列表。

import { useSyncExternalStore } from 'react';

/** `'all'` = 全部节点；否则为预选的一组节点 mesh id（可为空，对话框会默认选第一台可用节点）。 */
export type LoginCodeSelection = 'all' | readonly string[];

export interface LoginCodeRequest {
  selection: LoginCodeSelection;
  /** 每次请求自增：同一选择重复打开时对话框也要重置。 */
  seq: number;
}

let current: LoginCodeRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestLoginCode(selection: LoginCodeSelection): void {
  seq += 1;
  current = { selection, seq };
  emit();
}

export function closeLoginCodeRequest(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function useLoginCodeRequest(): LoginCodeRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null
  );
}
