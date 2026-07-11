// Agent 装饰面：设备树本体不感知 agent 领域类型，宿主经该适配器注入会话装饰。

import type { TmuxPane } from '@tmex/shared';
import type { ComponentType } from 'react';

/** 设备树内部导航面：与点击 pane 完全同款（清 pending 导航、派发选择事件、SPA 跳转） */
export interface DeviceTreeNavigation {
  navigateToPane(
    deviceId: string,
    windowId: string,
    paneId: string,
    options?: { keepSidebarOpen?: boolean }
  ): void;
}

/**
 * 侧边栏设备树的 agent 会话装饰适配器。
 * 未注入（或 runtime.features.agentUi 关断）时，设备树不渲染任何 agent 面：
 * 「新建 Agent 会话」菜单项、pane 会话分支、孤立会话区、会话对话框均不出现。
 */
export interface SidebarAgentAdapter {
  /** 窗口/pane 菜单「新建 Agent 会话」动作 */
  onCreateSessionForPane(
    nav: DeviceTreeNavigation,
    deviceId: string,
    windowId: string,
    pane: TmuxPane
  ): void;
  /** 挂在 pane（或单 pane 窗口）节点下的会话分支 */
  PaneSessions: ComponentType<{
    nav: DeviceTreeNavigation;
    deviceId: string;
    paneId: string;
  }>;
  /** 设备列表底部的孤立会话折叠区；无孤立会话时应返回 null */
  OrphanSessions: ComponentType<{
    nav: DeviceTreeNavigation;
    knownDeviceIds: readonly string[];
  }>;
  /** 会话重命名/删除等对话框（挂在设备树根部） */
  Dialogs: ComponentType;
}
