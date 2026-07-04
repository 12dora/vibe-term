// 设备连接关闭事件总线：push/watch 检测到设备 runtime 关闭时通知 agent supervisor，
// 后者主动停止绑定该设备的运行中 agent session（避免工具反复超时后才失败）。
// 仿 snapshot-directory 的注册表解耦模式（agent 不能直接引用 push/watch 模块）。

type DeviceCloseListener = (deviceId: string) => void;

let listener: DeviceCloseListener | null = null;

export function registerDeviceCloseListener(fn: DeviceCloseListener | null): void {
  listener = fn;
}

export function notifyDeviceClose(deviceId: string): void {
  listener?.(deviceId);
}
