// 侧栏「新建文件夹 / 重命名 / 删除」的请求通道：菜单项只往这里投一条请求，
// 真正的对话框整棵树只挂一份（见 file-ops-host）。
//
// 用外部 store 而不是 Provider 的 state：请求变化只该重渲染那一份对话框，
// 放进 state 会连带把 Provider 之下的整棵文件树重渲染一遍。

import type { ListFilesResponse } from '@vibeterm/shared';

export interface FileOpsEntryRef {
  path: string;
  name: string;
}

export type FileOpsRequest =
  | { kind: 'newFolder'; rootId: string; dir: string }
  | { kind: 'rename'; rootId: string; path: string; name: string; isDir: boolean }
  | { kind: 'delete'; rootId: string; entries: FileOpsEntryRef[] };

export interface FileOpsRequestApi {
  requestNewFolder(rootId: string, dir: string): void;
  requestRename(rootId: string, path: string, name: string, isDir: boolean): void;
  requestDelete(rootId: string, entries: FileOpsEntryRef[]): void;
}

/**
 * 关闭后 `request` 保留到下一次请求：对话框退场动画期间标题与名称不该先消失。
 * `seq` 每来一条请求加一，宿主拿它当对话框的 key——每条请求各有一份全新的组件状态。
 */
export interface FileOpsRequestState {
  request: FileOpsRequest | null;
  open: boolean;
  seq: number;
}

export interface FileOpsRequestStore extends FileOpsRequestApi {
  get: () => FileOpsRequestState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  /** 只在对话框仍显示着 `request` 这一条时才关：迟到的完成回调不该关掉后来的对话框。 */
  closeRequest: (request: FileOpsRequest) => void;
}

export const CLOSED_FILE_OPS_STATE: FileOpsRequestState = { request: null, open: false, seq: 0 };

export function createFileOpsRequestStore(): FileOpsRequestStore {
  let state = CLOSED_FILE_OPS_STATE;
  const listeners = new Set<() => void>();
  const set = (next: FileOpsRequestState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const open = (request: FileOpsRequest) => set({ request, open: true, seq: state.seq + 1 });
  const close = () => {
    if (state.open) set({ ...state, open: false });
  };
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
    closeRequest: (request) => {
      if (state.request === request) close();
    },
    requestNewFolder: (rootId, dir) => open({ kind: 'newFolder', rootId, dir }),
    requestRename: (rootId, path, name, isDir) =>
      open({ kind: 'rename', rootId, path, name, isDir }),
    requestDelete: (rootId, entries) => {
      if (entries.length > 0) open({ kind: 'delete', rootId, entries });
    },
  };
}

/** 目录列表缓存里已有的名称；目录没展开过（无缓存）时为 undefined，由后端兜底重名。 */
export function listingNames(listing: ListFilesResponse | undefined): Set<string> | undefined {
  return listing ? new Set(listing.entries.map((entry) => entry.name)) : undefined;
}

const NO_NAMES: ReadonlySet<string> = new Set();

type NameRequest = Extract<FileOpsRequest, { kind: 'newFolder' | 'rename' }>;

/** 名称对话框针对的目录：新建在 `dir` 里，重命名看的是它所在的上级目录。 */
export function nameRequestDir(request: NameRequest, parentOf: (path: string) => string): string {
  return request.kind === 'newFolder' ? request.dir : parentOf(request.path);
}

export function namesOrEmpty(names: ReadonlySet<string> | undefined): ReadonlySet<string> {
  return names ?? NO_NAMES;
}
