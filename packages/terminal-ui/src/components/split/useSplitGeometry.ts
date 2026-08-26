// 分屏几何：tmux layout 字符串 → 渲染几何（比例 cells）、pane 元信息索引、标题栏堆叠深度。

import type { TmuxLayoutNode, TmuxPane, TmuxWindow } from '@tmex/shared';
import { parseWindowLayout } from '@tmex/shared';
import { type RefObject, useMemo, useRef } from 'react';
import {
  type SplitLayoutGeometry,
  computeSplitLayoutGeometry,
  maxHorizontalStackDepth,
  maxVerticalStackDepth,
  paneSizesKey,
} from '../splitLayoutGeometry';

export interface SplitGeometryState {
  layoutRoot: TmuxLayoutNode | null;
  geometry: SplitLayoutGeometry | null;
  /** 渲染期同步更新的 geometry 引用：effect 里读它，避免 layout 字符串抖动造成的引用依赖 */
  geometryRef: RefObject<SplitLayoutGeometry | null>;
  rootCols: number;
  rootRows: number;
  paneInfoById: Map<string, TmuxPane>;
  /** pane 尺寸签名：只在 paneId/cols/rows 变化时变化 */
  paneSizes: string;
  /** 最深垂直堆叠数：整窗 rows 按它扣除标题栏总高 */
  titleBarStackDepth: number;
  /** 最宽水平并排数：整窗 cols 按它扣除左右留白 */
  horizontalStackDepth: number;
  /** 集合语义的 pane id 串：避免快照刷新引用变化导致 effect 空转 */
  knownPaneIdsKey: string;
}

export function useSplitGeometry(tmuxWindow: TmuxWindow): SplitGeometryState {
  const paneInfoById = useMemo(() => {
    const map = new Map<string, TmuxPane>();
    for (const pane of tmuxWindow.panes) {
      map.set(pane.id, pane);
    }
    return map;
  }, [tmuxWindow.panes]);

  const layout = useMemo(
    () => (tmuxWindow.layout ? parseWindowLayout(tmuxWindow.layout) : null),
    [tmuxWindow.layout]
  );

  // 几何单位先用 cells，渲染时换算为百分比（容器与 window 尺寸过渡期失配时仍铺满）
  const geometry = useMemo(() => {
    if (!layout) return null;
    return computeSplitLayoutGeometry(layout.root, { width: 1, height: 1 });
  }, [layout]);

  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  // 每个 pane 的标题栏占据实际空间：整窗 rows 按最深的一列扣除标题栏总高，
  // 保证该列的终端区也能放下 layout 分配的行数（其余列底部允许少量留白）
  const titleBarStackDepth = useMemo(
    () => (layout ? maxVerticalStackDepth(layout.root) : 1),
    [layout]
  );
  const horizontalStackDepth = useMemo(
    () => (layout ? maxHorizontalStackDepth(layout.root) : 1),
    [layout]
  );

  return {
    layoutRoot: layout?.root ?? null,
    geometry,
    geometryRef,
    rootCols: layout?.root.width ?? 1,
    rootRows: layout?.root.height ?? 1,
    paneInfoById,
    paneSizes: paneSizesKey(geometry),
    titleBarStackDepth,
    horizontalStackDepth,
    knownPaneIdsKey: tmuxWindow.panes.map((pane) => pane.id).join(','),
  };
}
