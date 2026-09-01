// 文件侧栏要显示哪些根目录：启用 + 用户在设备卡片上开着「文件」开关 + 所属设备当前连着。
//
// 「所属设备连着」这一条是刻意的：SSH 设备断开后目录点开只会一路报错，留在树里纯属噪声。
// 断开 / 重连由 tmux store 的 deviceConnected 驱动，React Query 的缓存不用动——过滤器负责隐藏。

import type { DeviceType, FileRootDto } from '@tmex/shared';
import { isSidebarFilesVisible } from '@tmex/stores';

export interface FileRootVisibilityInput {
  roots: readonly FileRootDto[];
  /** 该 runtime 服务的 node；可见性偏好按 `${runtimeNodeId}:${deviceId}` 记 */
  runtimeNodeId: string;
  visibility: Record<string, boolean>;
  /** tmux store 的设备连接表 */
  deviceConnected: Record<string, boolean | undefined>;
}

/** 本机设备随网关一起在线，不需要显式连接；其余设备要连上才算可达，设备已不存在则不可达。 */
export function isFileRootDeviceReachable(
  deviceType: DeviceType | null,
  deviceId: string,
  deviceConnected: Record<string, boolean | undefined>
): boolean {
  if (deviceType === null) return false;
  if (deviceType === 'local') return true;
  return deviceConnected[deviceId] === true;
}

export function selectVisibleFileRoots({
  roots,
  runtimeNodeId,
  visibility,
  deviceConnected,
}: FileRootVisibilityInput): FileRootDto[] {
  return roots.filter(
    (root) =>
      root.enabled &&
      // 这里的 root 本身就是「该设备配过目录」的证据；缺省是否显示由 node 归属决定
      // （本机显示、远端隐藏，见 isSidebarFilesVisible）
      isSidebarFilesVisible(visibility, runtimeNodeId, root.deviceId, true) &&
      isFileRootDeviceReachable(root.deviceType, root.deviceId, deviceConnected)
  );
}
