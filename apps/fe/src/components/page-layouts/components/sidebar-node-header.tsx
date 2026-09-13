// 侧边栏 node 分节头：节点徽标，可选折叠开关与整节拖拽手柄。

import { NodeBadge } from '@vibeterm/panels/device-tree';
import { cn } from '@vibeterm/ui';
import { ChevronRight } from 'lucide-react';
import { type SidebarNodeEntry, type SidebarNodeSortable, badgeOf } from './sidebar-node-model';

/**
 * 分节头兼作整节的拖拽手柄：鼠标要移动 8px 才激活（`useDeviceTreeSensors`），
 * 触摸要长按 250ms，所以头里的按钮照常点得动；`touch-pan-y` 让竖向滑动仍归页面滚动。
 */
export function SectionHeader({
  node,
  hint,
  drag,
  disclosure,
}: {
  node: SidebarNodeEntry;
  hint?: string;
  drag?: SidebarNodeSortable;
  /** 传了就把节点名做成折叠开关（远端在线分节）；不传即今天的静态分节头。 */
  disclosure?: { expanded: boolean; onToggle: () => void };
}) {
  const badge = <NodeBadge info={badgeOf(node)} variant="plain" className="min-w-0 flex-1" />;
  return (
    <div
      ref={drag?.sortable.setDragHandleRef}
      {...drag?.sortable.dragHandleProps}
      aria-label={drag?.dragHandleLabel}
      className={cn(
        'flex items-center gap-2 px-1 py-0.5',
        drag && 'cursor-grab touch-pan-y select-none'
      )}
      data-testid={`sidebar-node-header-${node.runtimeNodeId}`}
    >
      {disclosure ? (
        <button
          type="button"
          onClick={disclosure.onToggle}
          aria-expanded={disclosure.expanded}
          data-testid={`sidebar-node-toggle-${node.runtimeNodeId}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left hover:bg-sidebar-accent"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
              disclosure.expanded && 'rotate-90'
            )}
          />
          {badge}
        </button>
      ) : (
        badge
      )}
      {hint && (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}
