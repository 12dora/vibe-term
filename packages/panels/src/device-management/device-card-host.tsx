// 单张设备卡片的宿主：把编辑对话框与删除确认的状态下放到每张卡片，
// 这样文件夹、拖拽等外层容器可以直接复用一张「自带交互」的卡片。

import type { Device } from '@tmex/shared';
import { type CSSProperties, useState } from 'react';
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
  style?: CSSProperties;
  className?: string;
}

export function DeviceCardHost({
  device,
  queryKey,
  nodeContext,
  connection,
  style,
  className,
}: DeviceCardHostProps) {
  const [editing, setEditing] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Device | null>(null);

  return (
    <>
      <DeviceCard
        device={device}
        nodeContext={nodeContext}
        connection={connection}
        style={style}
        className={className}
        onEdit={() => setEditing(true)}
        onDelete={() => setDeleteCandidate(device)}
      />
      {editing && (
        <DeviceDialog
          mode="edit"
          device={device}
          nodeContext={nodeContext}
          queryKey={queryKey}
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
