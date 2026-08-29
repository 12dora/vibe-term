// 拖拽预览（DragOverlay）只拿得到条目 key，而设备名只在各自 node 的运行时里查得到。
// 渲染过设备卡片的地方把名字记在这里，预览按 `${runtimeNodeId}:${deviceId}` 现取；
// 取不到就退回设备 id，绝不因此额外发请求。

const names = new Map<string, string>();

function cacheKey(runtimeNodeId: string, deviceId: string): string {
  return `${runtimeNodeId}:${deviceId}`;
}

export function rememberDeviceName(runtimeNodeId: string, deviceId: string, name: string): void {
  if (!name) return;
  names.set(cacheKey(runtimeNodeId, deviceId), name);
}

export function deviceDisplayName(runtimeNodeId: string, deviceId: string): string {
  return names.get(cacheKey(runtimeNodeId, deviceId)) ?? deviceId;
}

export function resetDeviceNameCacheForTest(): void {
  names.clear();
}
