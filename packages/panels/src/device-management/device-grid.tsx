// 设备卡片网格：dnd-kit 排序容器 + 每张卡片的拖动把手；首屏逐项入场的样式由 state 给。

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { fetchFileRoots } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { GripVertical } from 'lucide-react';
import { type CSSProperties, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DeviceCardHost, type DeviceCardHostProps } from './device-card-host';
import { deviceGridCollisionDetection } from './device-grid-collision';
import type { useDeviceManagementState } from './use-device-management-state';

const HANDLE_CLASS =
  'inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/60 transition-colors duration-(--tmex-motion-fast) ease-out hover:bg-accent hover:text-foreground active:cursor-grabbing motion-reduce:transition-none';

// hasRoots 逐设备不同，不进这份「整列表共用」的 props
type CardProps = Omit<
  DeviceCardHostProps,
  'device' | 'hasRoots' | 'dragHandle' | 'style' | 'className'
>;

// 记忆化 + 上面稳定下来的 card：一台设备的状态变化不再重渲染整页卡片
const SortableDeviceCard = memo(function SortableDeviceCard({
  device,
  disabled,
  hasRoots,
  style,
  card,
}: {
  device: Device;
  disabled: boolean;
  hasRoots: boolean;
  style?: CSSProperties;
  card: CardProps;
}) {
  const { t } = useTranslation();
  const sortable = useSortable({ id: device.id, disabled });

  const dragHandle = disabled ? null : (
    <button
      type="button"
      ref={sortable.setActivatorNodeRef}
      data-testid={`device-card-handle-${device.id}`}
      aria-label={t('device.dragHandle')}
      title={t('device.dragHandle')}
      className={HANDLE_CLASS}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  );

  // 拖起来的卡片要有「被拎起」的观感：抬高层级 + 放大一点 + 更重的投影。
  // 缩放只能拼进内联 transform——tailwind 的 scale-* 会被这里的内联 transform 盖掉。
  const translate = CSS.Translate.toString(sortable.transform);
  const dragging = sortable.isDragging;
  return (
    <div
      ref={sortable.setNodeRef}
      data-testid={`device-card-slot-${device.id}`}
      data-dragging={dragging ? 'true' : undefined}
      className={cn(
        'min-w-0 rounded-xl',
        dragging && 'z-10 shadow-2xl ring-2 ring-ring/30 motion-reduce:shadow-lg'
      )}
      style={{
        ...style,
        transform:
          dragging && !disabled
            ? `${translate ?? ''} scale(1.03)`.trim()
            : (translate ?? undefined),
        transition: sortable.transition,
      }}
    >
      <DeviceCardHost device={device} hasRoots={hasRoots} dragHandle={dragHandle} {...card} />
    </div>
  );
});

export function DeviceGrid({
  state,
  card,
}: {
  state: ReturnType<typeof useDeviceManagementState>;
  card: CardProps;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const { devices, deviceIds, reorderDisabled } = state;
  const deviceIdsWithRoots = useDeviceIdsWithRoots(card.offline ?? false);
  // 宿主每次渲染都新建 card 字面量；按字段锁住引用，卡片的 memo 才拦得住
  const { queryKey, nodeContext, connection, offline } = card;
  const cardProps = useMemo<CardProps>(
    () => ({ queryKey, nodeContext, connection, offline }),
    [queryKey, nodeContext, connection, offline]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={deviceGridCollisionDetection}
      onDragEnd={state.onDragEnd}
    >
      <SortableContext items={deviceIds} strategy={rectSortingStrategy} disabled={reorderDisabled}>
        <div
          data-testid="devices-grid"
          // 自适应列数：每列至少 24rem，设备名与 SSH 目标才有地方放（窄屏退回单列）
          className={cn(
            'grid grid-cols-[repeat(auto-fill,minmax(min(24rem,100%),1fr))] gap-3',
            state.staggering && 'tmex-stagger'
          )}
          onAnimationEnd={state.onAnimationEnd}
        >
          {devices.map((device, index) => (
            <SortableDeviceCard
              key={device.id}
              device={device}
              disabled={reorderDisabled}
              hasRoots={deviceIdsWithRoots.has(device.id)}
              style={state.staggerStyle(device.id, index)}
              card={cardProps}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/**
 * 整个列表只订阅一次文件根，归并成设备 id 集合下发给卡片。
 * 与文件侧栏同一个 query key：`file-roots` 设置事件失效 ['files'] 后，
 * 在弹窗里配完目录，卡片上的「文件」开关立刻从禁用变可用。
 */
function useDeviceIdsWithRoots(offline: boolean): ReadonlySet<string> {
  const runtime = useRuntime();
  const rootsQuery = useQuery({
    queryKey: ['files', 'roots'],
    queryFn: () => fetchFileRoots(runtime.apiClient),
    enabled: runtime.features.filesUi && !offline,
    throwOnError: false,
  });
  const roots = rootsQuery.data?.roots;
  return useMemo(() => new Set((roots ?? []).map((root) => root.deviceId)), [roots]);
}
