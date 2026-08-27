// 窗口行与 pane 行共用的外壳：sortable 容器 + 拖拽手柄 + 行内绝对定位锚点 + 菜单槽。
// 菜单/关闭按钮的 absolute 锚点必须只包住行本身（children/actions 同层），
// 若锚在外层（含 footer 里的 Agent session 分支），挂了会话后 top-1/2 会随容器撑高而错位。

import { cn } from '@tmex/ui';
import { GripVertical } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import type { SortableRow } from './device-tree-dnd';

export type DeviceTreeRowVariant = 'window' | 'pane';

interface DragHandleStyle {
  desktop: string;
  mobile: string;
  icon: string;
  iconMobile: string;
}

const DRAG_HANDLE_STYLES: Record<DeviceTreeRowVariant, DragHandleStyle> = {
  window: {
    desktop: 'h-6 w-3.5 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4',
    mobile: 'h-9 w-4',
    icon: 'h-3.5 w-3.5',
    iconMobile: 'h-4 w-4',
  },
  pane: {
    desktop: 'h-6 w-3 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:w-4',
    mobile: 'h-9 w-4',
    icon: 'h-3 w-3',
    iconMobile: 'h-4 w-4',
  },
};

const DRAG_HANDLE_BASE =
  'touch-none cursor-grab shrink-0 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground opacity-100';

const stopClickPropagation = (event: MouseEvent<HTMLButtonElement>) => event.stopPropagation();

/** 行内菜单/关闭按钮的显隐：选中恒显，未选中悬停才显；粗指针设备恒显 */
export function rowActionVisibilityClass(isActive: boolean, groupHoverClass: string): string {
  if (isActive) return 'opacity-100';
  return `opacity-0 ${groupHoverClass} [@media(any-pointer:coarse)]:opacity-100`;
}

export interface DeviceTreeRowShellProps {
  variant: DeviceTreeRowVariant;
  sortable: SortableRow;
  isMobile: boolean;
  dragHandleLabel: string;
  /** 行内绝对定位所依赖的 group 名，如 `group` / `group/pane` */
  rowGroupClassName: string;
  outerClassName?: string;
  /** 行主体（可点击按钮） */
  children: ReactNode;
  /** 行尾操作区（菜单、关闭按钮），与 children 同处绝对定位锚点内 */
  actions?: ReactNode;
  /** 行下方的子树（pane 列表 / Agent 会话分支） */
  footer?: ReactNode;
}

export function DeviceTreeRowShell({
  variant,
  sortable,
  isMobile,
  dragHandleLabel,
  rowGroupClassName,
  outerClassName,
  children,
  actions,
  footer,
}: DeviceTreeRowShellProps) {
  const handle = DRAG_HANDLE_STYLES[variant];

  return (
    <div
      ref={sortable.setNodeRef}
      style={sortable.style}
      className={cn(outerClassName, sortable.isDragging && 'opacity-60')}
    >
      <div className={cn(rowGroupClassName, 'relative flex items-center gap-1')}>
        <button
          type="button"
          ref={sortable.setDragHandleRef}
          {...sortable.dragHandleProps}
          aria-label={dragHandleLabel}
          onClick={stopClickPropagation}
          className={cn(DRAG_HANDLE_BASE, isMobile ? handle.mobile : handle.desktop)}
        >
          <GripVertical className={isMobile ? handle.iconMobile : handle.icon} />
        </button>
        {children}
        {actions}
      </div>
      {footer}
    </div>
  );
}
