// 树根共享右键菜单的事件委托逻辑：从事件目标找回是哪一行、以及该不该把手势交回 base-ui。
// 全部只依赖 `AttrElement`（`closest` + `getAttribute`），无 DOM 环境下可用替身单测。

import type { FileRootDto, ListFilesResponse } from '@tmex/shared';
import {
  type AttrElement,
  type FileLeafTarget,
  closestFileLeaf,
  readFileLeafRef,
  resolveFileLeafTarget,
} from './file-leaf-target';

export type { FileLeafTarget } from './file-leaf-target';

export interface LeafHit {
  target: FileLeafTarget;
  row: AttrElement;
}

function asAttrElement(target: unknown): AttrElement | null {
  const candidate = target as AttrElement | null;
  return candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.closest === 'function'
    ? candidate
    : null;
}

/** 事件目标落在哪一行文件上；不在文件行内、或该行的 entry 已不在缓存里都返回 null */
export function hitFileLeaf(
  eventTarget: unknown,
  roots: readonly FileRootDto[],
  listing: (rootId: string, dir: string) => ListFilesResponse | undefined
): LeafHit | null {
  const row = closestFileLeaf(asAttrElement(eventTarget));
  if (!row) return null;
  const target = resolveFileLeafTarget(readFileLeafRef(row), roots, listing);
  return target ? { target, row } : null;
}

/**
 * 右键 / 长按是否放行给 base-ui 的 Trigger。
 *
 * `touches` 为 undefined 表示鼠标右键；多指触摸不是长按手势，一律挡掉（base-ui 自己也只认单指，
 * 这里提前挡住是为了不留下半个已 arm 的状态）。
 */
export function armFileLeafMenu(
  hit: LeafHit | null,
  touches: number | undefined,
  prevent: () => void
): LeafHit | null {
  if (touches !== undefined && touches !== 1) {
    prevent();
    return null;
  }
  if (!hit) {
    prevent();
    return null;
  }
  return hit;
}

/** 行原本兼任 Trigger，靠 base-ui 的 `data-popup-open` / `data-pressed` 高亮；提走后手动补上。 */
export function markOpenRow(row: unknown, open: boolean): void {
  const el = row as {
    setAttribute?: (n: string, v: string) => void;
    removeAttribute?: (n: string) => void;
  } | null;
  if (!el || typeof el.setAttribute !== 'function' || typeof el.removeAttribute !== 'function') {
    return;
  }
  if (open) {
    el.setAttribute('data-popup-open', '');
    el.setAttribute('data-pressed', '');
  } else {
    el.removeAttribute('data-popup-open');
    el.removeAttribute('data-pressed');
  }
}
