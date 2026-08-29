// 设备管理面板：设备卡片网格（节点内可拖拽排序）+ 新建对话框 + 空态/加载/错误态
// （每张卡片的编辑与删除由 DeviceCardHost 自己管）。数据自取（fetchDevices + 注入 queryKey），
// REST 一律经 runtime.apiClient；「添加设备」既可经全局事件（缺省监听，多面板宿主可关）也可经
// ref 命令式打开。
//
// `offline`：所属节点离线。不再拉列表，卡片来自 query 缓存里最近一次成功的列表，缓存也没有时
// 退回宿主给的 `fallbackDevices`（本地快照 / 节点 inventory）；卡片带 offline 标记、排序禁用。
//
// 宽度与内边距由页面级容器统一负责，本面板只是 `w-full`。

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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type DevicesResponse,
  devicesQueryKey as defaultDevicesQueryKey,
  fetchDevices,
  reorderDevices,
} from '@tmex/api-client';
import type { Device, LocaleCode } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';
import { useRuntime, useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Card, CardContent } from '@tmex/ui/card';
import { staggerItemStyle } from '@tmex/ui/motion';
import { GripVertical, Monitor, Plus } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceCardHost } from './device-card-host';
import { DeviceDialog } from './device-dialog';
import type { DeviceNodeContext } from './device-node-context';
import { OPEN_ADD_DEVICE_EVENT } from './events';

/** 首屏逐项入场的延迟档位上限（35ms/档），超出的卡片与最后一档同时进场 */
const STAGGER_MAX_INDEX = 11;
/** 入场动画兜底：animationend 没等到（隐藏标签页等）也在此之后摘掉 stagger 类 */
const STAGGER_FALLBACK_MS = 1500;

export interface DeviceManagementPanelHandle {
  openAddDevice(): void;
}

/**
 * 全局「添加设备」事件的订阅；`enabled` 为 false 时**不注册任何监听**，
 * 供聚合宿主（每个 node 一个面板）避免一次事件同时弹开所有面板的对话框。
 */
export function subscribeOpenAddDevice(
  enabled: boolean,
  onOpen: () => void
): (() => void) | undefined {
  if (!enabled) return undefined;
  window.addEventListener(OPEN_ADD_DEVICE_EVENT, onOpen);
  return () => window.removeEventListener(OPEN_ADD_DEVICE_EVENT, onOpen);
}

/**
 * 卡片顺序与侧边栏 Panes Tab 一致：先 sortOrder，再按设备名 locale 感知排序。
 * 顺带按 id 去重：同一个 id 出现两次会渲染出两张一模一样的卡片（React key 也会撞），
 * 列表可能来自缓存 + 快照 + 节点 inventory 几处，这里统一兜住。
 */
export function sortDevices<T extends Pick<Device, 'id' | 'name' | 'sortOrder'>>(
  devices: readonly T[],
  language: LocaleCode
): T[] {
  const byId = new Map<string, T>();
  for (const device of devices) {
    if (!byId.has(device.id)) byId.set(device.id, device);
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
  );
}

export interface DeviceManagementPanelProps {
  /** 设备列表查询 key；多实例宿主按 gateway 区分，缺省与既有共享缓存一致 */
  devicesQueryKey?: readonly unknown[];
  /** 是否监听全局 OPEN_ADD_DEVICE_EVENT 打开新建对话框；多面板宿主可关掉改用 ref 控制 */
  listenOpenAddDeviceEvent?: boolean;
  /** 该面板所展示的 node；缺省视为 entry 自身 */
  nodeContext?: DeviceNodeContext;
  /** 有它卡片才显示真实连接/断开开关；没有时退化为只有「打开」 */
  connection?: DeviceConnectionAdapter;
  /** 所属节点离线：不拉列表，卡片来自缓存 / fallbackDevices，并带 offline 标记 */
  offline?: boolean;
  /** 离线且缓存里没有列表时用的设备（本地快照 / 节点 inventory） */
  fallbackDevices?: readonly Device[];
  /** 每次成功拿到设备列表时回调（宿主用来写离线快照） */
  onDevicesLoaded?: (devices: Device[]) => void;
  className?: string;
  ref?: Ref<DeviceManagementPanelHandle>;
}

function useDeviceGridSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
}

const HANDLE_CLASS =
  'inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/60 transition-colors duration-(--tmex-motion-fast) ease-out hover:bg-accent hover:text-foreground active:cursor-grabbing motion-reduce:transition-none';

function SortableDeviceCard({
  device,
  disabled,
  style,
  children,
}: {
  device: Device;
  disabled: boolean;
  style?: CSSProperties;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: device.id, disabled });

  const dragHandle = disabled ? null : (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-testid={`device-card-handle-${device.id}`}
      aria-label={t('device.dragHandle')}
      title={t('device.dragHandle')}
      className={HANDLE_CLASS}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  );

  // 拖起来的卡片要有「被拎起」的观感：抬高层级 + 放大一点 + 更重的投影。
  // 缩放只能拼进内联 transform——tailwind 的 scale-* 会被这里的内联 transform 盖掉。
  const translate = CSS.Translate.toString(transform);
  return (
    <div
      ref={setNodeRef}
      data-testid={`device-card-slot-${device.id}`}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn(
        'min-w-0 rounded-xl',
        isDragging && 'z-10 shadow-2xl ring-2 ring-ring/30 motion-reduce:shadow-lg'
      )}
      style={{
        ...style,
        transform:
          isDragging && !disabled
            ? `${translate ?? ''} scale(1.03)`.trim()
            : (translate ?? undefined),
        transition,
      }}
    >
      {children(dragHandle)}
    </div>
  );
}

export function DeviceManagementPanel({
  devicesQueryKey = defaultDevicesQueryKey,
  listenOpenAddDeviceEvent = true,
  nodeContext,
  connection,
  offline = false,
  fallbackDevices,
  onDevicesLoaded,
  className,
  ref,
}: DeviceManagementPanelProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [showAddModal, setShowAddModal] = useState(false);
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  const resolvedNodeContext = useMemo<DeviceNodeContext>(
    () => nodeContext ?? { runtimeNodeId: runtime.nodeId, name: '', isSelf: true },
    [nodeContext, runtime.nodeId]
  );

  useImperativeHandle(ref, () => ({ openAddDevice: () => setShowAddModal(true) }), []);

  useEffect(
    () => subscribeOpenAddDevice(listenOpenAddDeviceEvent, () => setShowAddModal(true)),
    [listenOpenAddDeviceEvent]
  );
  useEffect(() => {
    if (offline) setShowAddModal(false);
  }, [offline]);

  const { data, isLoading, isError } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
    enabled: !offline,
  });

  const hydrateDeviceErrors = useTmuxStore((state) => state.hydrateDeviceErrors);

  useEffect(() => {
    if (!data?.devices) return;
    hydrateDeviceErrors(
      data.devices.map((d) => ({
        deviceId: d.id,
        lastError: d.lastError ?? null,
        lastErrorType: d.lastErrorType ?? null,
      }))
    );
    onDevicesLoaded?.(data.devices);
  }, [data, hydrateDeviceErrors, onDevicesLoaded]);

  const devices = useMemo(() => {
    const list = data?.devices ?? (offline ? fallbackDevices : undefined);
    return list ? sortDevices(list, language) : undefined;
  }, [data?.devices, offline, fallbackDevices, language]);

  // 逐项入场只做首屏那一批，动画跑完就摘掉 stagger 类：之后 refetch / 重排 / 状态更新都不再
  // 重放（DOM 节点被移动时 CSS 动画会重新触发，摘掉类是唯一稳妥的办法）。
  const initialBatchRef = useRef<ReadonlySet<string> | null>(null);
  if (initialBatchRef.current === null && devices) {
    initialBatchRef.current = new Set(devices.map((device) => device.id));
  }
  const initialBatch = initialBatchRef.current;
  const [entered, setEntered] = useState(false);
  const enteredCountRef = useRef(0);
  useEffect(() => {
    if (!initialBatch || entered) return;
    if (initialBatch.size === 0) {
      setEntered(true);
      return;
    }
    const timer = window.setTimeout(() => setEntered(true), STAGGER_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [initialBatch, entered]);
  const handleAnimationEnd = useCallback(() => {
    if (!initialBatch || entered) return;
    enteredCountRef.current += 1;
    if (enteredCountRef.current >= initialBatch.size) setEntered(true);
  }, [initialBatch, entered]);

  const reorderMutation = useMutation({
    mutationFn: (deviceIds: string[]) => reorderDevices(deviceIds, runtime.apiClient),
    onMutate: async (deviceIds: string[]) => {
      await queryClient.cancelQueries({ queryKey: devicesQueryKey });
      const previous = queryClient.getQueryData<DevicesResponse>(devicesQueryKey);
      if (previous) {
        const byId = new Map(previous.devices.map((device) => [device.id, device]));
        const reordered = deviceIds.flatMap((id, index) => {
          const device = byId.get(id);
          return device ? [{ ...device, sortOrder: index }] : [];
        });
        const rest = previous.devices.filter((device) => !deviceIds.includes(device.id));
        queryClient.setQueryData(devicesQueryKey, { devices: [...reordered, ...rest] });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(devicesQueryKey, context.previous);
      toast.error(t('device.reorderFailed'));
    },
    onSuccess: (result) => {
      queryClient.setQueryData(devicesQueryKey, result);
    },
  });

  const deviceIds = useMemo(() => (devices ?? []).map((device) => device.id), [devices]);
  const reorderMutate = reorderMutation.mutate;
  const reorderPending = reorderMutation.isPending;
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (offline || reorderPending || !over || active.id === over.id) return;
      const from = deviceIds.indexOf(String(active.id));
      const to = deviceIds.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      reorderMutate(arrayMove([...deviceIds], from, to));
    },
    [deviceIds, reorderMutate, offline, reorderPending]
  );
  const sensors = useDeviceGridSensors();
  const reorderDisabled = offline || reorderPending || deviceIds.length < 2;

  const emptyState = (
    <Card size="sm" className="tmex-reveal">
      <CardContent className="space-y-3 py-8 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted">
          <Monitor className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium">{t('device.noDevices')}</h2>
          <p className="text-xs text-muted-foreground">{t('device.addDevice')}</p>
        </div>
        <Button
          variant="default"
          size="sm"
          data-testid="devices-add-empty"
          onClick={() => setShowAddModal(true)}
        >
          <Plus className="h-4 w-4" />
          {t('device.addDevice')}
        </Button>
      </CardContent>
    </Card>
  );

  const offlineEmptyState = (
    <div
      data-testid="devices-offline-empty"
      className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-3 text-xs text-muted-foreground/70"
    >
      {t('devices.nodes.noKnownDevices')}
    </div>
  );

  let body: ReactNode;
  if (!devices) {
    body =
      isLoading || (!isError && !offline) ? (
        <Card size="sm" className="tmex-reveal">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('common.loading')}
          </CardContent>
        </Card>
      ) : offline ? (
        offlineEmptyState
      ) : (
        <Card size="sm" className="tmex-reveal">
          <CardContent className="py-10 text-center text-sm text-destructive">
            {t('device.loadFailed')}
          </CardContent>
        </Card>
      );
  } else if (devices.length === 0) {
    body = offline ? offlineEmptyState : emptyState;
  } else {
    body = (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={deviceIds}
          strategy={rectSortingStrategy}
          disabled={reorderDisabled}
        >
          <div
            data-testid="devices-grid"
            className={cn(
              // 自适应列数：每列至少 18rem，设备名与 SSH 目标才有地方放（窄屏退回单列）
              'grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-3',
              !entered && 'tmex-stagger'
            )}
            onAnimationEnd={handleAnimationEnd}
          >
            {devices.map((device, index) => (
              <SortableDeviceCard
                key={device.id}
                device={device}
                disabled={reorderDisabled}
                style={
                  !entered && initialBatch?.has(device.id)
                    ? staggerItemStyle(Math.min(index, STAGGER_MAX_INDEX))
                    : undefined
                }
              >
                {(dragHandle) => (
                  <DeviceCardHost
                    device={device}
                    queryKey={devicesQueryKey}
                    nodeContext={resolvedNodeContext}
                    connection={connection}
                    offline={offline}
                    dragHandle={dragHandle}
                  />
                )}
              </SortableDeviceCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  }

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-3', className)} data-testid="devices-page">
      {offline && devices && devices.length > 0 && (
        <p data-testid="devices-offline-hint" className="text-[11px] text-muted-foreground/70">
          {t('devices.nodes.offlineSnapshot')}
        </p>
      )}
      {body}

      {showAddModal && !offline && (
        <DeviceDialog
          mode="create"
          nodeContext={resolvedNodeContext}
          queryKey={devicesQueryKey}
          offline={offline}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
