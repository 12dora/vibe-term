// 文件侧栏里的「一个 node」分节：节点徽标做分节头，下面挂该 node 的文件树。
//
// 三种形态：
//   - 在线且已登录：宿主把本组件包在该 node 的运行时里，分节头下渲染真实文件树；
//     该 node 一个可见目录都没有时整节不渲染（见 `FilesNodeRootsSection`）；
//   - 在线但未登录：只留宿主给的一行登录入口，不发任何请求；
//   - 离线：只留一行「节点离线」。
//
// 分节可折叠（收起即卸载文件树，连带停掉该 node 的 files 查询），也可整节拖动排序
// ——顺序与终端侧栏共用一份 UI 偏好，由宿主持久化。

import { NodeBadge, type NodeBadgeInfo } from '../device-tree/node-badge';

import { useIsFetching } from '@tanstack/react-query';
import { cn } from '@tmex/ui';
import { ChevronRight, GripVertical, Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SortableRow } from '../device-tree/device-tree-dnd';
import { FilesNodeRoots, useVisibleFileRoots } from './files-node-roots';

export interface FilesNodeInfo {
  /** mesh 列表里的真实 node id（分节顺序按它记）。 */
  id: string;
  /** 运行时 / 路由 id：entry 自身为 `self`。 */
  runtimeNodeId: string;
  name: string;
  online: boolean;
  loggedIn: boolean;
  isSelf: boolean;
}

/** 整节的拖拽接线；未传即不可拖（单元测试直接渲染分节时）。 */
export interface FilesNodeSortable {
  sortable: SortableRow;
  dragHandleLabel: string;
}

export interface FilesNodeSectionProps {
  node: FilesNodeInfo;
  drag?: FilesNodeSortable;
  /** 在线但未登录时代替文件树的一行；登录入口在宿主侧（`@/auth`）。 */
  renderLogin?: (node: FilesNodeInfo) => ReactNode;
}

function badgeOf(node: FilesNodeInfo): NodeBadgeInfo {
  return {
    nodeId: node.runtimeNodeId,
    name: node.name,
    online: node.online,
    isSelf: node.isSelf,
  };
}

function FilesNodeSectionShell({
  node,
  drag,
  busy = false,
  children,
}: {
  node: FilesNodeInfo;
  drag?: FilesNodeSortable;
  busy?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      ref={drag?.sortable.setNodeRef}
      style={drag?.sortable.style}
      data-testid={`files-node-section-${node.runtimeNodeId}`}
      className={cn('space-y-0.5', drag?.sortable.isDragging && 'opacity-60')}
    >
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          data-testid={`files-node-toggle-${node.runtimeNodeId}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left hover:bg-sidebar-accent"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
          <NodeBadge info={badgeOf(node)} variant="plain" className="min-w-0 flex-1" />
        </button>
        {busy && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60 motion-reduce:animate-none" />
        )}
        {drag && (
          <button
            type="button"
            ref={drag.sortable.setDragHandleRef}
            {...drag.sortable.dragHandleProps}
            aria-label={drag.dragHandleLabel}
            className="flex h-6 w-3.5 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/50 hover:text-muted-foreground [@media(any-pointer:coarse)]:h-7 [@media(any-pointer:coarse)]:w-4"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {expanded && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

/**
 * 在线且已登录：分节头随该 node 的 files 查询转圈，下面就是这台 node 的文件树。
 *
 * 一个可见目录都没有的 node 整节不渲染（连分节头都不出）——hub 下挂几十台 node，
 * 用户没开过开关的节点只会堆成一屏空标题。目录列表回来之前同样不渲染，避免头闪一下又消失；
 * 加载失败要出头，错误提示与重试按钮挂在里面。
 */
function FilesNodeRootsSection({ node, drag }: { node: FilesNodeInfo; drag?: FilesNodeSortable }) {
  const fetching = useIsFetching({ queryKey: ['files'] });
  const { rootsQuery, roots } = useVisibleFileRoots();

  if (!rootsQuery.isError && (!rootsQuery.isSuccess || roots.length === 0)) return null;

  return (
    <FilesNodeSectionShell node={node} drag={drag} busy={fetching > 0}>
      <FilesNodeRoots />
    </FilesNodeSectionShell>
  );
}

export function FilesNodeSection({ node, drag, renderLogin }: FilesNodeSectionProps) {
  const { t } = useTranslation();

  if (!node.online) {
    return (
      <FilesNodeSectionShell node={node} drag={drag}>
        <div
          data-testid={`files-node-offline-${node.runtimeNodeId}`}
          className="px-2 py-1.5 text-[11px] text-muted-foreground/60"
        >
          {t('files.nodeOffline')}
        </div>
      </FilesNodeSectionShell>
    );
  }

  if (!node.loggedIn) {
    return (
      <FilesNodeSectionShell node={node} drag={drag}>
        <div
          data-testid={`files-node-login-${node.runtimeNodeId}`}
          className="flex flex-col gap-1 px-2 pb-1"
        >
          <span className="text-[11px] text-muted-foreground/70">{t('files.nodeSignInHint')}</span>
          {renderLogin?.(node)}
        </div>
      </FilesNodeSectionShell>
    );
  }

  return <FilesNodeRootsSection node={node} drag={drag} />;
}
