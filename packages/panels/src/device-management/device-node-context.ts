// 设备的「所属节点」渲染上下文。`Device.type` 只有 local | ssh，「是否属于远端 mesh 节点」
// 是宿主按运行时注入的展示信息，不落在数据里。

import type { DeviceType } from '@tmex/shared';
import type { TFunction } from 'i18next';

export interface DeviceNodeContext {
  /** 运行时 / 路由 id：entry 自身为 `self`，远端为 mesh node id */
  runtimeNodeId: string;
  /** 展示名（self 也给真实主机名，可为空串） */
  name: string;
  isSelf: boolean;
}

export type DeviceDisplayKind = 'local' | 'ssh' | 'nodeLocal' | 'nodeSsh';

export function deviceDisplayKind(
  deviceType: DeviceType,
  ctx: Pick<DeviceNodeContext, 'isSelf'>
): DeviceDisplayKind {
  if (ctx.isSelf) {
    return deviceType;
  }
  return deviceType === 'local' ? 'nodeLocal' : 'nodeSsh';
}

/** 远端节点上的设备：连接参数由该节点自己管，本地只做展示与可见性偏好。 */
export function isRemoteDeviceKind(kind: DeviceDisplayKind): boolean {
  return kind === 'nodeLocal' || kind === 'nodeSsh';
}

export function deviceKindLabel(t: TFunction, kind: DeviceDisplayKind, nodeName: string): string {
  switch (kind) {
    case 'local':
      return t('device.kind.local');
    case 'ssh':
      return t('device.kind.ssh');
    case 'nodeLocal':
      return t('device.kind.nodeLocal', { node: nodeName });
    default:
      return t('device.kind.nodeSsh', { node: nodeName });
  }
}
