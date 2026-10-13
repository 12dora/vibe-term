// 「把一批条目送到某个目录」的请求：拖放与剪贴板粘贴都归一成它，由宿主执行
// （同节点同设备走移动接口，其余走跨设备复制任务）。

import { dirname } from '@vibeterm/shared';
import type { ExplorerClipboard } from '@vibeterm/stores';
import { type ExplorerDragPayload, type ExplorerDropDest, resolveDropKind } from './model';

export interface ExplorerTransferRequest {
  /** 粘贴时由剪贴板内容拼出同样的结构 */
  source: ExplorerDragPayload;
  dest: ExplorerDropDest;
  kind: 'move' | 'copy';
  /** 目标目录里已有的名称（用于冲突预检）；不知道时为 null */
  destNames: ReadonlySet<string> | null;
  /** 剪切后的粘贴：宿主受理后清空剪贴板 */
  cut?: boolean;
}

export function requestFromDrop(
  payload: ExplorerDragPayload,
  dest: ExplorerDropDest,
  kind: 'move' | 'copy',
  destNames: ReadonlySet<string> | null
): ExplorerTransferRequest {
  return { source: payload, dest, kind, destNames };
}

/** 剪贴板内容还原成拖拽载荷的形状；所在目录取第一项的父目录。 */
export function clipboardSource(
  clipboard: ExplorerClipboard,
  names: string[],
  hasDirectory: boolean
): ExplorerDragPayload {
  return {
    nodeId: clipboard.nodeId,
    rootId: clipboard.rootId,
    deviceId: clipboard.deviceId,
    dir: dirname(clipboard.paths[0] ?? '/'),
    paths: [...clipboard.paths],
    names,
    hasDirectory,
  };
}

/**
 * 剪切 → 同节点同设备为移动，否则退化为复制（仍带 `cut`，宿主受理后清空剪贴板）；复制 → 复制。
 * 粘不进去（剪切后粘回原目录、目录粘进自身或其子孙、剪贴板为空）时返回 null。
 */
export function requestFromClipboard(
  clipboard: ExplorerClipboard,
  names: string[],
  hasDirectory: boolean,
  dest: ExplorerDropDest,
  destNames: ReadonlySet<string> | null
): ExplorerTransferRequest | null {
  if (clipboard.paths.length === 0 || names.length !== clipboard.paths.length) return null;
  const source = clipboardSource(clipboard, names, hasDirectory);
  const cut = clipboard.mode === 'cut';
  const kind = resolveDropKind(source, dest, !cut);
  if (kind === 'none') return null;
  return cut ? { source, dest, kind, destNames, cut: true } : { source, dest, kind, destNames };
}
