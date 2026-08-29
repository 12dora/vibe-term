// node 标识（多 node 聚合视图的分节头用）。单 node / standalone 宿主没有分节头，也就不渲染它。

import { cn } from '@tmex/ui';
import { Server } from 'lucide-react';

export interface NodeBadgeInfo {
  /** 路由用的 nodeId（entry 自身为 `self`）。 */
  nodeId: string;
  /** 展示名，来自 `/api/mesh/nodes` 的 `name`。 */
  name: string;
  online: boolean;
  /** entry 自身的 node。 */
  isSelf?: boolean;
}

export interface NodeBadgeAppearance {
  label: string;
  title: string;
  dimmed: boolean;
}

/**
 * `chip` 为带边框的徽标（设备管理页的分组头）；`plain` 去掉边框，只留状态点 + 名称，
 * 给侧边栏这种寸土寸金的窄栏用。
 */
export type NodeBadgeVariant = 'chip' | 'plain';

/** 纯函数：标识文案与灰显判定（离线 node 灰显，见设计 §4「侧边栏聚合视图」）。 */
export function nodeBadgeAppearance(info: NodeBadgeInfo): NodeBadgeAppearance {
  const label = info.name.trim() || info.nodeId;
  return {
    label,
    title: `${label} · ${info.nodeId}`,
    dimmed: !info.online,
  };
}

export function NodeBadge({
  info,
  className,
  variant = 'chip',
}: {
  info: NodeBadgeInfo;
  className?: string;
  variant?: NodeBadgeVariant;
}) {
  const appearance = nodeBadgeAppearance(info);
  const shared = {
    'data-testid': `node-badge-${info.nodeId}`,
    'data-online': info.online,
    'data-variant': variant,
    title: appearance.title,
  };

  if (variant === 'plain') {
    return (
      <span
        {...shared}
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold leading-none',
          appearance.dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground',
          className
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            appearance.dimmed ? 'bg-gray-400' : 'bg-emerald-500'
          )}
        />
        <span className="truncate">{appearance.label}</span>
      </span>
    );
  }

  return (
    <span
      {...shared}
      className={cn(
        'inline-flex max-w-[7rem] shrink-0 items-center gap-1 rounded border border-border/60 px-1 py-px text-[10px] leading-none',
        appearance.dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground',
        className
      )}
    >
      <Server className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{appearance.label}</span>
    </span>
  );
}
