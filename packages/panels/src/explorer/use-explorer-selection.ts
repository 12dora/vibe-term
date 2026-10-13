// 选择状态：换目录即清空；列表刷新后摘掉已消失的项；
// 「等它出现在列表里再选中」用于返回上一级（选中刚才所在的文件夹）以及新建 / 重命名之后。

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { type ExplorerLocationRef, childToReselect } from './explorer-derive';
import { EMPTY_SELECTION, type SelectionState, pruneSelection, selectOnly } from './model';
import { useKeyedState, useLatest } from './use-keyed-state';

export interface ExplorerSelectionApi {
  selection: SelectionState;
  /** 用户操作产生的选择变化；同时放弃尚未兑现的「等它出现再选中」 */
  setSelection(next: SelectionState): void;
  /** `path` 出现在列表里时选中并滚到可见处（已在列表里则立刻生效） */
  selectWhenListed(path: string): void;
}

export interface ExplorerSelectionOptions {
  location: ExplorerLocationRef;
  /** 当前可见条目的路径（已筛选、已排序） */
  order: readonly string[];
  /** 列表数据已到位；加载中不做修剪 */
  ready: boolean;
  onReveal(path: string): void;
}

export function useExplorerSelection(options: ExplorerSelectionOptions): ExplorerSelectionApi {
  const { location, order, ready } = options;
  const { rootId, path } = location;
  const key = `${rootId}\n${path}`;
  const [selection, setHeld] = useKeyedState<SelectionState>(key, EMPTY_SELECTION);
  const [pending, setPending] = useKeyedState<string | null>(key, null);
  const onRevealRef = useLatest(options.onReveal);

  const previous = useRef<ExplorerLocationRef | null>(null);
  useEffect(() => {
    const child = childToReselect(previous.current, { rootId, path });
    previous.current = { rootId, path };
    if (child !== null) setPending(child);
  }, [rootId, path, setPending]);

  useEffect(() => {
    if (!ready) return;
    if (pending !== null && order.includes(pending)) {
      setHeld(selectOnly(pending));
      setPending(null);
      onRevealRef.current(pending);
      return;
    }
    setHeld((current) => pruneSelection(current, order));
  }, [ready, order, pending, setHeld, setPending, onRevealRef]);

  const setSelection = useCallback(
    (next: SelectionState) => {
      setPending(null);
      setHeld(next);
    },
    [setHeld, setPending]
  );

  return useMemo(
    () => ({ selection, setSelection, selectWhenListed: setPending }),
    [selection, setSelection, setPending]
  );
}
