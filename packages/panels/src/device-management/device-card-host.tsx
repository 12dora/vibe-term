// 单张设备卡片的宿主：把编辑对话框与删除确认的状态下放到每张卡片，
// 这样分组、拖拽等外层容器可以直接复用一张「自带交互」的卡片。

import type { Device } from '@tmex/shared';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from 'react';
import type { DeviceConnectionAdapter } from '../device-connection';
import { DeviceCard } from './device-card';
import { DeviceDeleteDialog } from './device-delete-dialog';
import { DeviceDialog } from './device-dialog';
import type { DeviceNodeContext } from './device-node-context';

export interface DeviceCardHostProps {
  device: Device;
  queryKey: readonly unknown[];
  nodeContext: DeviceNodeContext;
  connection?: DeviceConnectionAdapter;
  offline?: boolean;
  dragHandle?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/**
 * 卡片交互的状态与回调。`onEdit` / `onDelete` 的身份只随 device 变：宿主自己开关对话框时
 * `DeviceCard` 的 memo 才可能真的 bail out（身份用例见 device-card.test.tsx）。
 */
export function useDeviceCardActions(device: Device) {
  const [editing, setEditing] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Device | null>(null);
  const onEdit = useCallback(() => setEditing(true), []);
  const onDelete = useCallback(() => setDeleteCandidate(device), [device]);
  return { editing, setEditing, deleteCandidate, setDeleteCandidate, onEdit, onDelete };
}

export function DeviceCardHost({
  device,
  queryKey,
  nodeContext,
  connection,
  offline,
  dragHandle,
  style,
  className,
}: DeviceCardHostProps) {
  const { editing, setEditing, deleteCandidate, setDeleteCandidate, onEdit, onDelete } =
    useDeviceCardActions(device);
  // 节点掉线：编辑 / 删除都要打远端 API，正开着的对话框直接关掉
  useEffect(() => {
    if (!offline) return;
    setEditing(false);
    setDeleteCandidate(null);
  }, [offline, setEditing, setDeleteCandidate]);

  return (
    <>
      <DeviceCard
        device={device}
        nodeContext={nodeContext}
        connection={connection}
        offline={offline}
        dragHandle={dragHandle}
        style={style}
        className={className}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      {editing && (
        <DeviceDialog
          mode="edit"
          device={device}
          nodeContext={nodeContext}
          queryKey={queryKey}
          offline={offline}
          onClose={() => setEditing(false)}
        />
      )}
      <DeviceDeleteDialog
        device={deleteCandidate}
        queryKey={queryKey}
        onClose={() => setDeleteCandidate(null)}
      />
    </>
  );
}
