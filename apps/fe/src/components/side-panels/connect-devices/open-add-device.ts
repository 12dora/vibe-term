// 打开本机节点的「新建设备」对话框。
//
// 对话框归设备页的面板管，只有设备页挂载时才存在；面板里点按钮时页面多半还没挂上，
// 所以先导航、再等它把自己登记进 `add-device-targets` 注册表，登记完成立刻打开。
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

/** 返回取消函数：面板先卸载时调用，别把订阅与定时器留在后面。 */
export function openSelfAddDevice(options: OpenAddDeviceOptions = {}): () => void {
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
  // 已经在设备页时注册表当场就有目标；仍推迟一拍，等导航把面板关掉再弹对话框。
  setTimeout(attempt, 0);
  return stop;
}
