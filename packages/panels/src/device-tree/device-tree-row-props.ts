// 窗口行 / pane 行与其各分段共用的 props 面；集中在这里避免分段文件反向 import 行组件。

import type { Device, TmuxPane, TmuxWindow } from '@tmex/shared';
import type { DeviceConnectionAdapter } from '../device-connection';
import type { DeviceTreeNavigation, SidebarAgentAdapter } from './agent-adapter';

export interface DeviceRowProps {
  device: Device;
  isExpanded: boolean;
  isSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onExpandedChange: (deviceId: string, expanded: boolean) => void;
  onCreateWindow: (deviceId: string) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
  /** 宿主连接管理；未传时不渲染连接开关，行为与内嵌宿主一致 */
  connection?: DeviceConnectionAdapter;
}

export interface PaneRowProps {
  deviceId: string;
  windowId: string;
  pane: TmuxPane;
  isActive: boolean;
  isMobile: boolean;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}

export interface WindowRowProps {
  deviceId: string;
  tmuxWindow: TmuxWindow;
  isDeviceSelected: boolean;
  selectedWindowId?: string;
  selectedPaneId?: string;
  onPaneClick: (deviceId: string, windowId: string, paneId: string) => void;
  onWindowClick: (deviceId: string, windowId: string, panes: TmuxPane[]) => void;
  onCloseWindow: (deviceId: string, windowId: string) => void;
  onClosePane: (deviceId: string, windowId: string, paneId: string) => void;
  onRenameWindow: (deviceId: string, windowId: string) => void;
  onRenamePane: (deviceId: string, paneId: string) => void;
  onWatchPane: (deviceId: string, paneId: string) => void;
  agent?: SidebarAgentAdapter;
  nav: DeviceTreeNavigation;
}
