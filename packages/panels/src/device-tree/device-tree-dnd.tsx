import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
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

/**
 * 指针优先的碰撞检测。
 *
 * `closestCenter` 比的是**被拖元素整块矩形**的中心到各落点中心的距离，行高相差悬殊时会直接
 * 拖不动：侧栏里展开着设备树的节点分节能有几百像素高，它下面的离线分节只有一行，要让高分节
 * 的中心越过矮分节的中心，指针得往下拖出大半个列表——用户看到的就是「本机节点拖不到中间/
 * 底部」。改成先看指针落在哪个落点矩形里，落在两块之间的空隙（或用键盘排序，没有指针坐标）
 * 时再退回中心距离，兜住 `over` 不会变成 null。
 */
export const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  return collisions.length > 0 ? collisions : closestCenter(args);
};

/**
 * 只保留纵向位移。竖排列表横着拖没有任何语义，却有两个真实后果：被拖的行会跟着指针平移，
 * 平移出来的溢出把侧栏滚动容器撑成横向可滚，dnd-kit 的自动滚动接着把整条侧栏往右拽。
 * 抹掉 `x` 后拖拽矩形不再横移，自动滚动的横向意图也一并归零（纵向自动滚动照常）。
 *
 * 自己写而不引 `@dnd-kit/modifiers`：整个包就为这三行，不值当多一个依赖。
 */
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

// 常量数组：每次渲染新建会让 DndContext 重建 modifier 链
const VERTICAL_ONLY: Modifier[] = [restrictToVerticalAxis];

export interface SortableVerticalListProps {
  ids: string[];
  onReorder: (nextIds: string[]) => void;
  /** 上一次重排还在飞时置真：并发的重排请求会让先发后到的旧顺序覆盖新顺序 */
  disabled?: boolean;
  /** 覆盖碰撞检测；缺省为指针优先（见 `pointerFirstCollisionDetection`） */
  collisionDetection?: CollisionDetection;
  children: ReactNode;
}

/** 设备树三层共用的竖向排序容器；自身不产生 DOM 节点 */
export function SortableVerticalList({
  ids,
  onReorder,
  disabled = false,
  collisionDetection = pointerFirstCollisionDetection,
  children,
}: SortableVerticalListProps) {
  const sensors = useDeviceTreeSensors();
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={VERTICAL_ONLY}
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
