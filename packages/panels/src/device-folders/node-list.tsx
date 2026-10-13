// 一个容器（根层 / 某个分组）里的节点磁贴网格。
//
// 版式规则见 `node-grid.ts`：列数跟容器宽度走，磁贴跨度 = min(设备数, 列数)，顺序不重排。
// 网格项默认 `align-items: stretch`，同一行的磁贴外壳等高——碰撞判定（`collision.ts`）靠
// 这一点认「同一行」，不要改成 `items-start`。

import { useDndContext } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@vibeterm/ui';
import { useTranslation } from 'react-i18next';
import { DeviceFolderNodeShell } from './draggable-item';
import { FolderDropArea } from './folder-section';
import {
  PLACEHOLDER_ITEM_ID,
  bodyDropZoneId,
  containerFolderId,
  containerItemIds,
  parseNodeElementId,
} from './folder-tree-model';
import {
  NODE_GRID_CLASS,
  NODE_GRID_CONTAINER_CLASS,
  NODE_TILE_SPAN_CLASS,
  type NodeTileSize,
} from './node-grid';
import { useTree } from './tree-context';

/** 量不到被拖节点高度时占位条的兜底高度 */
const PLACEHOLDER_MIN_HEIGHT = 48;

/** 占位条的最小高度：被拖磁贴量到的高度，量不到（或太矮）时用兜底值 */
export function placeholderMinHeight(activeHeight: number | null | undefined): number {
  return Math.max(activeHeight ?? 0, PLACEHOLDER_MIN_HEIGHT);
}

function NodeItem({
  nodeId,
  containerId,
  folderId,
}: {
  nodeId: string;
  containerId: string;
  folderId: string | null;
}) {
  const { renderNode, nodeDraggable, dragDisabled, placedNodeIds, nodeSpan } = useTree();
  const implicit = !placedNodeIds.has(nodeId);
  const size = nodeSpan(nodeId, folderId);
  if (nodeDraggable && !nodeDraggable(nodeId, { folderId })) {
    const content = renderNode(nodeId, { folderId, implicit, dragDisabled, dragControls: null });
    if (content === null || content === undefined || content === false) return null;
    return (
      <div
        data-testid={`device-folder-item-node:${nodeId}`}
        data-span={size}
        className={cn('min-w-0', NODE_TILE_SPAN_CLASS[size])}
      >
        {content}
      </div>
    );
  }
  return (
    <DeviceFolderNodeShell
      nodeId={nodeId}
      containerId={containerId}
      disabled={dragDisabled}
      span={size}
      className={NODE_TILE_SPAN_CLASS[size]}
    >
      {(dragControls) => renderNode(nodeId, { folderId, implicit, dragDisabled, dragControls })}
    </DeviceFolderNodeShell>
  );
}

/**
 * 跨容器拖拽时插进目标容器的占位条：按被拖磁贴的跨度占格（宽度因此就是它落进来之后的宽度，
 * 而不是它在原容器里的像素宽——两边列数可能不同），高度不低于被拖磁贴量到的高度，把后面的
 * 兄弟顶开。它不是 droppable，不参与落点判定；被拖的节点自始至终留在原容器里（只是变暗），
 * 免得它的 React 子树（宿主的 runtime scope / QueryClientProvider / 面板）在拖拽途中重挂。
 */
function DropPlaceholder({ folderId }: { folderId: string | null }) {
  const { active, activeNodeRect } = useDndContext();
  const { nodeSpan } = useTree();
  const nodeId = active ? parseNodeElementId(String(active.id)) : null;
  const size: NodeTileSize = nodeId ? nodeSpan(nodeId, folderId) : 1;
  return (
    <div
      aria-hidden="true"
      data-testid="device-folder-drop-placeholder"
      data-span={size}
      className={cn(
        'min-w-0 rounded-xl border-2 border-dashed border-ring/50 bg-accent/30',
        NODE_TILE_SPAN_CLASS[size]
      )}
      style={{ minHeight: placeholderMinHeight(activeNodeRect?.height) }}
    />
  );
}

export function NodeList({ containerId }: { containerId: string }) {
  const { t } = useTranslation();
  const tree = useTree();
  const container = tree.containers.get(containerId);
  const folderId = containerFolderId(containerId) ?? null;
  if (!container) return null;

  if (container.nodeIds.length === 0) {
    if (folderId === null) return null;
    // 空分组的落点提示不进网格：整行宽，哪一列都接得住
    return (
      <FolderDropArea
        zoneId={bodyDropZoneId(containerId)}
        testId={`device-folder-drop-${folderId}`}
        active={tree.dropContainerId === containerId}
        label={t('devices.folders.empty')}
        activeLabel={t('devices.folders.dropHere', {
          name: tree.foldersById.get(folderId)?.name ?? '',
        })}
      />
    );
  }

  const items = containerItemIds(containerId, container.nodeIds, tree.placeholder);

  return (
    <SortableContext
      items={container.nodeIds}
      strategy={rectSortingStrategy}
      disabled={tree.dragDisabled}
    >
      <div data-testid="devices-node-grid" className={NODE_GRID_CONTAINER_CLASS}>
        <div className={NODE_GRID_CLASS}>
          {items.map((elementId) => {
            if (elementId === PLACEHOLDER_ITEM_ID) {
              return <DropPlaceholder key={elementId} folderId={folderId} />;
            }
            const nodeId = parseNodeElementId(elementId);
            if (!nodeId) return null;
            return (
              <NodeItem
                key={elementId}
                nodeId={nodeId}
                containerId={containerId}
                folderId={folderId}
              />
            );
          })}
        </div>
      </div>
    </SortableContext>
  );
}
