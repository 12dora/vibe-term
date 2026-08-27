import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';

// device/window/pane 三层共用的拖拽 sensors：
// - 鼠标走 distance 约束（按下移动 8px 即激活，无 delay），根治 PC「按下即拖」起不来；
// - 触摸走 delay 约束（长按 250ms 激活，移动 >5px 视为滚动手势让位原生滚动）；
// - 键盘走 sortable 的 coordinateGetter（可访问性）。
// 注：旧版 @dnd-kit/core PointerSensor 无法按 pointerType 分别配约束，故必须拆 Mouse + Touch。
export function useDeviceTreeSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
}

/** 拖拽结束后的新 id 顺序；未落在有效目标上返回 null（调用方不应发起重排） */
export function reorderIdsByDragEnd(ids: readonly string[], event: DragEndEvent): string[] | null {
  const { active, over } = event;
  if (!over || active.id === over.id) return null;
  const oldIndex = ids.indexOf(String(active.id));
  const newIndex = ids.indexOf(String(over.id));
  if (oldIndex < 0 || newIndex < 0) return null;
  return arrayMove([...ids], oldIndex, newIndex);
}

export interface SortableVerticalListProps {
  ids: string[];
  onReorder: (nextIds: string[]) => void;
  /** 上一次重排还在飞时置真：并发的重排请求会让先发后到的旧顺序覆盖新顺序 */
  disabled?: boolean;
  children: ReactNode;
}

/** 设备树三层共用的竖向排序容器；自身不产生 DOM 节点 */
export function SortableVerticalList({
  ids,
  onReorder,
  disabled = false,
  children,
}: SortableVerticalListProps) {
  const sensors = useDeviceTreeSensors();
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        if (disabled) return;
        const nextIds = reorderIdsByDragEnd(ids, event);
        if (nextIds) onReorder(nextIds);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={disabled}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** 行级 sortable 样板：外层容器 ref/transform + 拖拽手柄 props */
export function useSortableRow(id: string) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return {
    setNodeRef,
    setDragHandleRef: setActivatorNodeRef,
    style: { transform: CSS.Translate.toString(transform), transition },
    isDragging,
    dragHandleProps: { ...attributes, ...listeners },
  };
}

export type SortableRow = ReturnType<typeof useSortableRow>;
