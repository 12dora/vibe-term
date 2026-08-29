// 设备管理页文件夹层级契约：文件夹可任意嵌套；节点 / 设备通过 placement 落到某个文件夹
// （或 folderId=null 的根层显式排序）；没有 placement 的条目在根层按默认顺序排在最后。
// 数据只存在**提供 UI 的节点**（entry / self）自己的库里；self 节点的 nodeId 固定为 'self'，
// 远端 mesh 节点用其 mesh node id。

export type DeviceFolderItemKind = 'node' | 'device';

export interface DeviceFolder {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceFolderItemRef {
  kind: DeviceFolderItemKind;
  nodeId: string;
  /** kind='node' 时为 null */
  deviceId: string | null;
}

export interface DeviceFolderPlacement extends DeviceFolderItemRef {
  /** null = 根层（带显式顺序） */
  folderId: string | null;
  sortOrder: number;
}

export interface DeviceFolderLayout {
  folders: DeviceFolder[];
  placements: DeviceFolderPlacement[];
}

export interface CreateDeviceFolderRequest {
  name: string;
  parentId?: string | null;
}

export interface UpdateDeviceFolderRequest {
  name?: string;
  parentId?: string | null;
  sortOrder?: number;
}

export interface UpdateDeviceFolderLayoutRequest {
  /** 必须与库中现有文件夹 id 集合完全一致（只改层级 / 顺序，不增删） */
  folders: Array<Pick<DeviceFolder, 'id' | 'parentId' | 'sortOrder'>>;
  /** 整体替换全部 placement */
  placements: DeviceFolderPlacement[];
}

export const DEVICE_FOLDER_NAME_MAX_LENGTH = 64;
/** standalone / entry 自身在 placement 里的 nodeId */
export const DEVICE_FOLDER_SELF_NODE_ID = 'self';
