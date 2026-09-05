// 设置变更广播注册表：api 层无法直接引用 wsServer 实例（runtime 局部创建），
// 用注册表解耦。runtime.ts 启动时注册、stop 时注销。

export type SettingsNamespace =
  | 'site'
  | 'terminal-shortcuts'
  | 'theme'
  | 'llm'
  | 'file-roots'
  | 'webhooks'
  | 'telegram'
  | 'weixin'
  | 'devices'
  | 'tree-order'
  | 'device-folders';

type SettingsBroadcaster = (namespace: SettingsNamespace) => void;

let broadcaster: SettingsBroadcaster | null = null;

export function registerSettingsBroadcaster(fn: SettingsBroadcaster | null): void {
  broadcaster = fn;
}

export function broadcastSettingsUpdate(namespace: SettingsNamespace): void {
  broadcaster?.(namespace);
}

// tree-order / 自定义名的写入口桥：排序落库 + 自定义名内存 overlay 都由 wsServer
// 持有并负责快照重广播，REST 侧经此桥复用 WS 同一套逻辑。
export interface TreeOverlayBridge {
  reorderWindows: (deviceId: string, windowIds: string[]) => void;
  reorderPanes: (deviceId: string, windowId: string, paneIds: string[]) => void;
  renameWindow: (deviceId: string, windowId: string, name: string) => void;
  renamePane: (deviceId: string, paneId: string, name: string) => void;
  getCustomNames: (deviceId: string) => {
    windows: Record<string, string>;
    panes: Record<string, string>;
  };
}

let treeOverlayBridge: TreeOverlayBridge | null = null;

export function registerTreeOverlayBridge(bridge: TreeOverlayBridge | null): void {
  treeOverlayBridge = bridge;
}
