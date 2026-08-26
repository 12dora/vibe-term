import type { DropPosition } from '../splitLayoutGeometry';

export interface DragState {
  gutterIndex: number;
  deltaPx: number;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DragRect = RectLike;

export type PaneDragTarget =
  | { type: 'pane'; paneId: string; position: DropPosition }
  // 拖到侧栏其他窗口行：移入该窗口
  | { type: 'window'; windowId: string; rect: DragRect }
  // 拖到侧栏其余区域：拆为独立窗口
  | { type: 'break'; rect: DragRect };

export interface PaneDragState {
  srcPaneId: string;
  /** 超过拖拽阈值才算真正开始（避免与点击聚焦冲突） */
  active: boolean;
  pointerX: number;
  pointerY: number;
  target: PaneDragTarget | null;
}
