import type { ApiClient } from '@tmex/api-client';
import type { Device, DeviceType } from '@tmex/shared';

/** 增改弹窗设备选择器里的一个可选设备。 */
export interface FileRootDeviceOption {
  id: string;
  name: string;
  type?: DeviceType;
}

/** 注入的设备分组：组标签 + 组内设备 + 该组 file roots 的落盘 client。 */
export interface FileRootDeviceGroup {
  label: string;
  devices: FileRootDeviceOption[];
  /** 缺省用当前 runtime 的 apiClient */
  apiClient?: ApiClient;
}

export interface ResolveFileRootClientInput {
  isEdit: boolean;
  deviceId: string;
  /** 编辑模式下 root 的来源 client，优先于分组推导 */
  editClient?: ApiClient;
  fallbackClient: ApiClient;
  deviceGroups?: FileRootDeviceGroup[];
}

/** 列表聚合要读取的 client 集合：按注入分组去重，缺省只读本 gateway。 */
export function collectFileRootClients(
  fallbackClient: ApiClient,
  deviceGroups?: FileRootDeviceGroup[]
): ApiClient[] {
  if (!deviceGroups) {
    return [fallbackClient];
  }
  const clients: ApiClient[] = [];
  for (const group of deviceGroups) {
    const client = group.apiClient ?? fallbackClient;
    if (!clients.includes(client)) {
      clients.push(client);
    }
  }
  return clients;
}

/** 编辑沿用来源 client；新增按目标设备所属分组路由，找不到则落回本 gateway。 */
export function resolveFileRootClient(input: ResolveFileRootClientInput): ApiClient {
  if (input.isEdit) {
    return input.editClient ?? input.fallbackClient;
  }
  if (!input.deviceGroups) {
    return input.fallbackClient;
  }
  const group = input.deviceGroups.find((g) =>
    g.devices.some((device) => device.id === input.deviceId)
  );
  return group?.apiClient ?? input.fallbackClient;
}

export function deriveFileRootDeviceOptions(
  devices: Device[],
  deviceGroups?: FileRootDeviceGroup[]
): FileRootDeviceOption[] {
  return deviceGroups ? deviceGroups.flatMap((group) => group.devices) : devices;
}

export function isFileRootPathValid(path: string): boolean {
  return path.trim().startsWith('/');
}

export function canSubmitFileRootForm(input: {
  isEdit: boolean;
  deviceId: string;
  path: string;
}): boolean {
  return isFileRootPathValid(input.path) && (input.isEdit || input.deviceId.length > 0);
}
