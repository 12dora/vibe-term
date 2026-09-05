// 「添加设备」的全局事件名：宿主外壳（如页面右上 + 按钮）派发，面板监听打开新建对话框。

import type { DeviceType } from '@tmex/shared';

export const OPEN_ADD_DEVICE_EVENT = 'tmex:open-add-device';

/** 打开新建对话框时预选的设备类型；不给就用对话框自己的默认值。 */
export interface AddDevicePreset {
  type: DeviceType;
}

const DEVICE_TYPES = new Set<string>(['local', 'ssh']);

/** 事件 detail 由外部派发，形状不受控：只认约定字段，其余一律当作没有预选。 */
export function addDevicePresetFromEvent(event: Event): AddDevicePreset | undefined {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (detail === null || typeof detail !== 'object') return undefined;
  const type = (detail as { type?: unknown }).type;
  return typeof type === 'string' && DEVICE_TYPES.has(type)
    ? { type: type as DeviceType }
    : undefined;
}
