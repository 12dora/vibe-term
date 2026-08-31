// 侧栏根目录拖拽排序：把「可见列表的新顺序」还原成要提交的完整顺序，并给出重排的 mutation 接线。
//
// 侧栏只显示可见的根（见 root-visibility），提交的却必须是整份顺序——被过滤掉的根留在原位，
// 否则一次拖动会把隐藏的根统统挤到末尾。合并规则与设备树同一套。

import type { QueryClient } from '@tanstack/react-query';
import type { FileRootDto, ListFileRootsResponse } from '@tmex/shared';
import { reorderDevicesOptimistically } from '../device-tree/device-reorder';
import { mergeReorderedVisibleIds } from '../device-tree/device-tree-selectors';

/** 目录项重排的乐观更新：语义与设备重排一致（认识的 id 依次在前并重写 sortOrder）。 */
export { reorderDevicesOptimistically as reorderFileRootsOptimistically };

export const FILE_ROOTS_QUERY_KEY = ['files', 'roots'];

export function nextFileRootOrder(
  allRoots: readonly FileRootDto[],
  visibleIds: readonly string[],
  nextVisibleIds: readonly string[]
): string[] {
  return mergeReorderedVisibleIds(
    allRoots.map((root) => root.id),
    visibleIds,
    nextVisibleIds
  );
}

/**
 * 一次拖动结果要不要提交、提交什么。
 *
 * `pending` 为真（上一次重排还在飞）时直接不受理：并发提交会让先发后到的旧顺序覆盖新顺序。
 */
export function fileRootOrderToSubmit(
  allRoots: readonly FileRootDto[],
  visibleIds: readonly string[],
  nextVisibleIds: readonly string[],
  pending: boolean
): string[] | null {
  if (pending) return null;
  return nextFileRootOrder(allRoots, visibleIds, nextVisibleIds);
}

export interface FileRootReorderContext {
  previous: ListFileRootsResponse | undefined;
}

export interface FileRootReorderDeps {
  /** 该 node 自己的 QueryClient（每个 node 一份缓存）。 */
  queryClient: QueryClient;
  submit: (rootIds: string[]) => Promise<unknown>;
  /** 提交失败后的用户提示。 */
  onFailed: () => void;
}

/** 乐观更新 + 失败回滚 + 落定后按服务端顺序收口，抽成纯接线便于脱离 React 单测。 */
export function fileRootReorderOptions(deps: FileRootReorderDeps) {
  return {
    mutationFn: (rootIds: string[]) => deps.submit(rootIds),
    onMutate: async (rootIds: string[]): Promise<FileRootReorderContext> => {
      await deps.queryClient.cancelQueries({ queryKey: FILE_ROOTS_QUERY_KEY });
      const previous = deps.queryClient.getQueryData<ListFileRootsResponse>(FILE_ROOTS_QUERY_KEY);
      if (previous) {
        deps.queryClient.setQueryData(FILE_ROOTS_QUERY_KEY, {
          roots: reorderDevicesOptimistically(previous.roots, rootIds),
        });
      }
      return { previous };
    },
    onError: (_error: unknown, _rootIds: string[], context: FileRootReorderContext | undefined) => {
      if (context?.previous) {
        deps.queryClient.setQueryData(FILE_ROOTS_QUERY_KEY, context.previous);
      }
      deps.onFailed();
    },
    onSettled: () => {
      void deps.queryClient.invalidateQueries({ queryKey: FILE_ROOTS_QUERY_KEY });
    },
  };
}
