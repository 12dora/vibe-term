// 打开本机节点的「新建设备」对话框。
//
// 对话框归设备页的面板管，只有设备页挂载时才存在；面板里点按钮时页面多半还没挂上，
// 所以先登记等待器再导航，等设备页把自己写进 `add-device-targets` 注册表，登记完成立刻打开。
// 等不到就静默放弃（导航已经完成，用户在设备页手动点「+」即可）。

import {
  type AddDeviceTarget,
  getAddDeviceTargets,
  subscribeAddDeviceTargets,
} from '@/pages/devices/add-device-targets';

export interface AddDeviceTargetSource {
  get: () => readonly AddDeviceTarget[];
  subscribe: (onChange: () => void) => () => void;
}

const defaultSource: AddDeviceTargetSource = {
  get: getAddDeviceTargets,
  subscribe: subscribeAddDeviceTargets,
};

/** 设备页 chunk 加载 + 首次拉列表的余量；超时只是不再等，不报错。 */
export const ADD_DEVICE_WAIT_MS = 15_000;

export interface OpenAddDeviceOptions {
  source?: AddDeviceTargetSource;
  timeoutMs?: number;
}

/**
 * 同一时刻只留一个等待器：再点一次按钮就把上一个撤掉，免得两次点击开两遍对话框。
 * 等待器本身不挂在调用方的生命周期上——导航会把侧栏卸载，收尾只能靠超时或成功。
 */
let pending: (() => void) | null = null;

/** 返回取消函数：调用方主动放弃时用；正常路径由超时或成功自行收尾。 */
export function openSelfAddDevice(options: OpenAddDeviceOptions = {}): () => void {
  pending?.();
  const source = options.source ?? defaultSource;
  const timeoutMs = options.timeoutMs ?? ADD_DEVICE_WAIT_MS;
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    settled = true;
    unsubscribe?.();
    unsubscribe = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending === stop) pending = null;
  };

  const attempt = () => {
    if (settled) return;
    const target = source.get().find((row) => row.isSelf);
    if (!target) return;
    stop();
    target.open();
  };

  unsubscribe = source.subscribe(attempt);
  timer = setTimeout(stop, timeoutMs);
  pending = stop;
  // 已经在设备页时注册表当场就有目标；仍推迟一拍，等导航把面板关掉再弹对话框。
  setTimeout(attempt, 0);
  return stop;
}
