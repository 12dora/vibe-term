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
 * 单指 + 命中文件行才武装长按。
 *
 * 多指不是长按手势；未命中（加载行 / 空目录 / 「显示其余」/ 空白处）要把手势完整留给浏览器，
 * 既不弹上一次命中的那份菜单，也不挡掉原生菜单。
 */
export function shouldArmLongPress(hit: LeafHit | null, touches: number): hit is LeafHit {
  return touches === 1 && hit !== null;
}

/** 与 base-ui ContextMenuTrigger 一致的长按参数 */
export const FILE_LEAF_LONG_PRESS_MS = 500;
export const FILE_LEAF_LONG_PRESS_MOVE_PX = 10;

export interface PointerPoint {
  clientX: number;
  clientY: number;
}

export interface LongPressOptions<T> {
  onFire: (payload: T, point: PointerPoint) => void;
  delayMs?: number;
  moveThresholdPx?: number;
  schedule?: (run: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export interface LongPressTracker<T> {
  start: (payload: T, point: PointerPoint) => void;
  move: (point: PointerPoint) => void;
  cancel: () => void;
  /** 读取并清掉「刚触发过」标记：抬指时据此 preventDefault，抑制合成的 mouse 序列 */
  consumeFired: () => boolean;
}

export function createLongPress<T>({
  onFire,
  delayMs = FILE_LEAF_LONG_PRESS_MS,
  moveThresholdPx = FILE_LEAF_LONG_PRESS_MOVE_PX,
  schedule = (run, ms) => setTimeout(run, ms),
  unschedule = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: LongPressOptions<T>): LongPressTracker<T> {
  let handle: unknown = null;
  let origin: PointerPoint | null = null;
  let fired = false;

  const clear = (): void => {
    if (handle !== null) unschedule(handle);
    handle = null;
    origin = null;
  };

  return {
    start(payload, point) {
      clear();
      fired = false;
      origin = point;
      handle = schedule(() => {
        const at = origin;
        handle = null;
        origin = null;
        if (!at) return;
        fired = true;
        onFire(payload, at);
      }, delayMs);
    },
    move(point) {
      if (handle === null || !origin) return;
      const movedX = Math.abs(point.clientX - origin.clientX);
      const movedY = Math.abs(point.clientY - origin.clientY);
      if (movedX > moveThresholdPx || movedY > moveThresholdPx) clear();
    },
    cancel: clear,
    consumeFired() {
      const was = fired;
      fired = false;
      return was;
    },
  };
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
