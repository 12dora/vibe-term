// 设备管理页分组契约：分组只有一层（不能嵌套）；只有**节点**能被放进分组（或 folderId=null
// 的根层显式排序），设备永远跟着自己的节点走，只在节点内部排序。没有 placement 的节点在根层
// 按默认顺序排在最后。
// 数据只存在**提供 UI 的节点**（entry / self）自己的库里；self 节点的 nodeId 固定为 'self'，
// 远端 mesh 节点用其 mesh node id。

export interface DeviceFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceFolderPlacement {
  nodeId: string;
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
}

export interface UpdateDeviceFolderRequest {
  name?: string;
  sortOrder?: number;
}

export interface UpdateDeviceFolderLayoutRequest {
  /** 必须与库中现有分组 id 集合完全一致（只改顺序，不增删） */
  folders: Array<Pick<DeviceFolder, 'id' | 'sortOrder'>>;
  /** 整体替换全部 placement */
  placements: DeviceFolderPlacement[];
}

export const DEVICE_FOLDER_NAME_MAX_LENGTH = 64;
/** standalone / entry 自身在 placement 里的 nodeId */
export const DEVICE_FOLDER_SELF_NODE_ID = 'self';
