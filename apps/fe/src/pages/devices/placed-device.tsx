// 被单独放进文件夹的一台设备。
//
// 设备数据只在它所属 node 的运行时里查得到，所以这里在 `NodeRuntimeScope` 内自取设备列表，
// 再交给 `DeviceCardHost` 渲染单卡（自带编辑 / 删除对话框）。
// 节点离线 / 未登录，或设备已经不存在时渲染灰色占位——**不自动改布局**：设备可能只是暂时
// 拿不到（节点离线），静默删掉 placement 会让用户的整理成果不声不响地消失。

import { useGlobalDevice } from '@/components/global-device-provider';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { useQuery } from '@tanstack/react-query';
import { devicesQueryKey, fetchDevices } from '@tmex/api-client';
import { DeviceCardHost } from '@tmex/panels/device-management';
import type { Device, DeviceFolderItemRef } from '@tmex/shared';
import { deviceFolderItemKey } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { MonitorX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { rememberDeviceName } from './device-name-cache';
import { type NodeDeviceGroupEntry, nodeDeviceGroupState } from './node-device-group';

export type PlacedDeviceState =
  | { kind: 'missing' }
  | { kind: 'loading' }
  | { kind: 'ready'; device: Device };

/**
 * placement + 节点状态 + 该节点的设备列表 → 该渲染什么。
 * `devices` 为 undefined 表示列表还没回来（区别于「查过了但没有这台设备」）。
 */
export function resolvePlacedDevice(
  item: DeviceFolderItemRef,
  node: NodeDeviceGroupEntry | null,
  devices: Device[] | undefined
): PlacedDeviceState {
  if (item.kind !== 'device' || !item.deviceId) return { kind: 'missing' };
  if (!node || nodeDeviceGroupState(node) !== 'ready') return { kind: 'missing' };
  if (!devices) return { kind: 'loading' };
  const device = devices.find((candidate) => candidate.id === item.deviceId);
  return device ? { kind: 'ready', device } : { kind: 'missing' };
}

export function MissingDeviceCard({
  item,
  node,
}: {
  item: DeviceFolderItemRef;
  node: NodeDeviceGroupEntry | null;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`device-folder-missing-${deviceFolderItemKey(item)}`}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/30 px-3 py-2.5"
    >
      <MonitorX className="size-4 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">
          {t('devices.folders.missingDevice')}
        </p>
        <p className="truncate font-mono text-[10px] text-muted-foreground/60">
          {`${node?.name ?? item.nodeId} · ${item.deviceId ?? ''}`}
        </p>
      </div>
    </div>
  );
}

function PlacedDeviceBody({
  item,
  node,
}: {
  item: DeviceFolderItemRef;
  node: NodeDeviceGroupEntry;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const { connection } = useGlobalDevice();
  const { data } = useQuery({
    queryKey: devicesQueryKey,
    queryFn: () => fetchDevices(runtime.apiClient),
    throwOnError: false,
  });

  const state = resolvePlacedDevice(item, node, data?.devices);
  if (state.kind === 'missing') return <MissingDeviceCard item={item} node={node} />;
  if (state.kind === 'loading') {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  rememberDeviceName(node.runtimeNodeId, state.device.id, state.device.name);
  return (
    <DeviceCardHost
      device={state.device}
      queryKey={devicesQueryKey}
      nodeContext={{
        runtimeNodeId: node.runtimeNodeId,
        name: node.name,
        isSelf: node.isSelf,
      }}
      connection={connection}
    />
  );
}

export function PlacedDevice({
  item,
  node,
}: {
  item: DeviceFolderItemRef;
  node: NodeDeviceGroupEntry | null;
}) {
  // 离线 / 未登录的节点不建连接：与设备页分组、侧边栏聚合视图的规则一致
  if (!node || nodeDeviceGroupState(node) !== 'ready') {
    return <MissingDeviceCard item={item} node={node} />;
  }
  return (
    <NodeRuntimeScope nodeId={node.runtimeNodeId}>
      <PlacedDeviceBody item={item} node={node} />
    </NodeRuntimeScope>
  );
}
