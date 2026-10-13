// 一个容器（根层 / 某个分组）里的节点磁贴网格。
//
// 版式规则见 `node-grid.ts`：列数跟容器宽度走，磁贴跨度 = min(设备数, 列数)，顺序不重排。
// 网格项默认 `align-items: stretch`，同一行的磁贴外壳等高——碰撞判定（`collision.ts`）靠
// 这一点认「同一行」，不要改成 `items-start`。
//
// 拖拽预览 = 松手之后的真实排布：DOM 顺序始终是数据顺序（被拖节点不重挂、焦点不丢），预览只改
// 条目的 CSS `order`——同容器重排把被拖节点（变暗的那个）挪到落点，跨容器在落点摆占位条，
// 兄弟由网格真的回流让位，宽窄混排时也不会走样；位置变化由 `flip.ts` 补过渡。所以指针拖拽时
// sortable 不加任何位移（`noDisplacement`）。键盘拖拽例外：仍用 `rectSortingStrategy` 的位移
// 预览、不改 `order`、也不开回流过渡（见 `tree-context.ts` 的 `reflow`）。
// 回流会改变行数，网格高度在拖拽期间被冻结（`use-frozen-heights.ts`），不会从指针底下缩回去。

import { useDndContext, useDroppable } from '@dnd-kit/core';
import { SortableContext, type SortingStrategy, rectSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@vibeterm/ui';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceFolderNodeShell } from './draggable-item';
import { useFlipReflow } from './flip';
import { FolderDropArea } from './folder-section';
import {
  type DeviceFolderContainer,
  PLACEHOLDER_ITEM_ID,
  bodyDropZoneId,
  containerFolderId,
  nodeElementId,
  parseNodeElementId,
  previewItemOrder,
} from './folder-tree-model';
import {
  NODE_GRID_CLASS,
  NODE_GRID_CONTAINER_CLASS,
  NODE_TILE_SPAN_CLASS,
  type NodeTileSize,
} from './node-grid';
import { useTree } from './tree-context';
import { FREEZE_HEIGHT_ATTR } from './use-frozen-heights';

/** 量不到被拖节点高度时占位条的兜底高度 */
const PLACEHOLDER_MIN_HEIGHT = 48;

/** 占位条的最小高度：被拖磁贴量到的高度，量不到（或太矮）时用兜底值 */
export function placeholderMinHeight(activeHeight: number | null | undefined): number {
  return Math.max(activeHeight ?? 0, PLACEHOLDER_MIN_HEIGHT);
}

/** 兄弟一律不加位移：让位靠真实的网格回流 */
const noDisplacement: SortingStrategy = () => null;

/**
 * 预览期间每个条目的 CSS `order`（下标即视觉位置）；视觉顺序与 DOM 顺序一致时返回 null
 * （不在预览 / 预览落回原位），条目上就不留 `order`。
 */
export function previewOrderMap(
  domOrder: readonly string[],
  visualOrder: readonly string[]
): Map<string, number> | null {
  const same =
    domOrder.length === visualOrder.length && domOrder.every((id, i) => id === visualOrder[i]);
  return same ? null : new Map(visualOrder.map((id, index) => [id, index]));
}

function NodeItem({
  nodeId,
  containerId,
  folderId,
  order,
}: {
  nodeId: string;
  containerId: string;
  folderId: string | null;
  order: number | undefined;
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
        data-flip-id={nodeElementId(nodeId)}
        className={cn('min-w-0', NODE_TILE_SPAN_CLASS[size])}
        style={{ order }}
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
      order={order}
      className={NODE_TILE_SPAN_CLASS[size]}
    >
      {(dragControls) => renderNode(nodeId, { folderId, implicit, dragDisabled, dragControls })}
    </DeviceFolderNodeShell>
  );
}

/**
 * 跨容器拖拽时插进目标容器的占位条：按被拖磁贴的跨度占格（宽度因此就是它落进来之后的宽度，
 * 而不是它在原容器里的像素宽——两边列数可能不同），高度不低于被拖磁贴量到的高度，把后面的
 * 兄弟顶开。它注册成 droppable 只是为了让 dnd-kit 量出它当前的矩形（碰撞判定的迟滞要知道
 * 「预览现在摆在哪」），不是落点，判定永远不会返回它；被拖的节点自始至终留在原容器里（只是
 * 变暗），免得它的 React 子树（宿主的 runtime scope / QueryClientProvider / 面板）在拖拽途中重挂。
 */
function DropPlaceholder({ folderId, order }: { folderId: string | null; order: number }) {
  const { active, activeNodeRect } = useDndContext();
  const { setNodeRef } = useDroppable({ id: PLACEHOLDER_ITEM_ID });
  const { nodeSpan } = useTree();
  const nodeId = active ? parseNodeElementId(String(active.id)) : null;
  // 松手之后到布局落定之间占位条还在（见 `use-tree-drag.ts`），那时已经没有 active：
  // 沿用拖拽中最后一次的跨度与高度，不让它在最后几帧缩成兜底尺寸。
  const shape = useRef<{ size: NodeTileSize; minHeight: number } | null>(null);
  if (nodeId) {
    shape.current = {
      size: nodeSpan(nodeId, folderId),
      minHeight: placeholderMinHeight(activeNodeRect?.height),
    };
  }
  const size = shape.current?.size ?? 1;
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      data-testid="device-folder-drop-placeholder"
      data-span={size}
      data-flip-id={PLACEHOLDER_ITEM_ID}
      className={cn(
        'min-w-0 rounded-xl border-2 border-dashed border-ring/50 bg-accent/30',
        NODE_TILE_SPAN_CLASS[size]
      )}
      style={{ order, minHeight: shape.current?.minHeight ?? placeholderMinHeight(null) }}
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

  return <NodeGrid container={container} />;
}

function NodeGrid({ container }: { container: DeviceFolderContainer }) {
  const tree = useTree();
  const { containerId, folderId, nodeIds } = container;
  const visual = previewItemOrder(containerId, nodeIds, tree.placeholder, tree.reorder);
  const orders = previewOrderMap(nodeIds, visual);
  const placeholderOrder = orders?.get(PLACEHOLDER_ITEM_ID);
  const gridRef = useRef<HTMLDivElement>(null);
  // 键盘拖拽时兄弟带着 sortable 的内联位移，布局位置没变：不做回流过渡
  useFlipReflow(gridRef, visual.join('|'), tree.flipTracking && tree.reflow);
  const freeze = { [FREEZE_HEIGHT_ATTR]: '' };

  return (
    <SortableContext
      items={nodeIds}
      strategy={tree.reflow ? noDisplacement : rectSortingStrategy}
      disabled={tree.dragDisabled}
    >
      <div data-testid="devices-node-grid" className={NODE_GRID_CONTAINER_CLASS}>
        <div ref={gridRef} className={NODE_GRID_CLASS} {...freeze}>
          {nodeIds.map((elementId) => {
            const nodeId = parseNodeElementId(elementId);
            if (!nodeId) return null;
            return (
              <NodeItem
                key={elementId}
                nodeId={nodeId}
                containerId={containerId}
                folderId={folderId}
                order={orders?.get(elementId)}
              />
            );
          })}
          {/* 占位条排在 DOM 末尾，位置由 `order` 决定：落点换来换去也是同一个元素，回流有过渡 */}
          {placeholderOrder !== undefined && (
            <DropPlaceholder folderId={folderId} order={placeholderOrder} />
          )}
        </div>
      </div>
    </SortableContext>
  );
}
