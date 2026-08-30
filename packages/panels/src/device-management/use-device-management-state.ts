// 设备管理面板的数据与交互状态：列表拉取（离线时退回缓存 / 宿主快照）、错误水合、
// 首屏逐项入场的收尾、拖拽重排的乐观更新。面板只负责渲染分支。

import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DevicesResponse, fetchDevices, reorderDevices } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { useRuntime, useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { staggerItemStyle } from '@tmex/ui/motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { reorderDevicesOptimistically } from '../device-tree/device-reorder';
import { sortDevices } from '../device-tree/device-tree-selectors';

/** 首屏逐项入场的延迟档位上限（35ms/档），超出的卡片与最后一档同时进场 */
const STAGGER_MAX_INDEX = 11;
/** 入场动画兜底：animationend 没等到（隐藏标签页等）也在此之后摘掉 stagger 类 */
const STAGGER_FALLBACK_MS = 1500;

const NO_DEVICES: Device[] = [];

export function useDeviceManagementState({
  devicesQueryKey,
  offline,
  fallbackDevices,
  onDevicesLoaded,
}: {
  devicesQueryKey: readonly unknown[];
  offline: boolean;
  fallbackDevices?: readonly Device[];
  onDevicesLoaded?: (devices: Device[]) => void;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  const hydrateDeviceErrors = useTmuxStore((state) => state.hydrateDeviceErrors);

  const { data, isError } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
    enabled: !offline,
  });

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

  const loaded = useMemo(() => {
    const list = data?.devices ?? (offline ? fallbackDevices : undefined);
    return list ? sortDevices(list, language) : undefined;
  }, [data?.devices, offline, fallbackDevices, language]);

  // 逐项入场只做首屏那一批，动画跑完就摘掉 stagger 类：之后 refetch / 重排 / 状态更新都不再
  // 重放（DOM 节点被移动时 CSS 动画会重新触发，摘掉类是唯一稳妥的办法）。
  const initialBatchRef = useRef<ReadonlySet<string> | null>(null);
  if (initialBatchRef.current === null && loaded) {
    initialBatchRef.current = new Set(loaded.map((device) => device.id));
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
  const onAnimationEnd = useCallback(() => {
    if (!initialBatch || entered) return;
    enteredCountRef.current += 1;
    if (enteredCountRef.current >= initialBatch.size) setEntered(true);
  }, [initialBatch, entered]);
  const staggerStyle = useCallback(
    (deviceId: string, index: number) =>
      !entered && initialBatch?.has(deviceId)
        ? staggerItemStyle(Math.min(index, STAGGER_MAX_INDEX))
        : undefined,
    [entered, initialBatch]
  );

  const reorderMutation = useMutation({
    mutationFn: (deviceIds: string[]) => reorderDevices(deviceIds, runtime.apiClient),
    onMutate: async (deviceIds: string[]) => {
      await queryClient.cancelQueries({ queryKey: devicesQueryKey });
      const previous = queryClient.getQueryData<DevicesResponse>(devicesQueryKey);
      if (previous) {
        queryClient.setQueryData(devicesQueryKey, {
          devices: reorderDevicesOptimistically(previous.devices, deviceIds),
        });
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

  // 拿到列表（离线时的空列表也算）为 ready，否则是加载中 / 加载失败
  const status: 'loading' | 'error' | 'ready' =
    loaded || offline ? 'ready' : isError ? 'error' : 'loading';

  const deviceIds = useMemo(() => (loaded ?? NO_DEVICES).map((device) => device.id), [loaded]);
  const reorderMutate = reorderMutation.mutate;
  const reorderDisabled = offline || reorderMutation.isPending || deviceIds.length < 2;
  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (reorderDisabled || !over || active.id === over.id) return;
      const from = deviceIds.indexOf(String(active.id));
      const to = deviceIds.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      reorderMutate(arrayMove([...deviceIds], from, to));
    },
    [deviceIds, reorderMutate, reorderDisabled]
  );

  return {
    status,
    devices: loaded ?? NO_DEVICES,
    deviceIds,
    reorderDisabled,
    staggering: !entered,
    staggerStyle,
    onAnimationEnd,
    onDragEnd,
  };
}
