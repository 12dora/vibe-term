/**
 * 设备重排的乐观更新（侧栏与设备管理面板共用）：认识的 id 依次排在前面并重写 `sortOrder`
 * （取该 id 在 `deviceIds` 里的下标），其余设备保持原相对顺序追加在后面，未知 id 丢弃。
 */
export function reorderDevicesOptimistically<T extends { id: string; sortOrder: number }>(
  devices: readonly T[],
  deviceIds: readonly string[]
): T[] {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const requested = new Set(deviceIds);
  const reordered = deviceIds.flatMap((id, index) => {
    const device = byId.get(id);
    return device ? [{ ...device, sortOrder: index }] : [];
  });
  return [...reordered, ...devices.filter((device) => !requested.has(device.id))];
}
