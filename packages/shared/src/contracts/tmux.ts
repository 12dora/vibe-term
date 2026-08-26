// tmux 领域实体与事件类型

export interface TmuxWindow {
  id: string;
  name: string;
  customName?: string;
  index: number;
  active: boolean;
  /** tmux #{window_layout} 布局字符串，分屏渲染的真相源 */
  layout?: string;
  panes: TmuxPane[];
}

export interface TmuxPane {
  id: string;
  windowId: string;
  index: number;
  title?: string;
  /** 用户自定义 pane 名（gateway 内存 overlay，优先于 title 展示） */
  customName?: string;
  /** pane 当前运行的进程名（tmux #{pane_current_command}） */
  currentCommand?: string;
  /** pane 当前工作目录（tmux #{pane_current_path}） */
  currentPath?: string;
  active: boolean;
  width: number;
  height: number;
  /** pane 左上角在 window 内的列偏移（tmux #{pane_left}） */
  left?: number;
  /** pane 左上角在 window 内的行偏移（tmux #{pane_top}） */
  top?: number;
}

export interface TmuxSession {
  id: string;
  name: string;
  windows: TmuxWindow[];
}

export interface TmuxBellEventData {
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  paneUrl?: string;
  paneTitle?: string;
  paneCurrentCommand?: string;
}

export type NotificationSource = 'osc9' | 'osc99' | 'osc777' | 'osc1337';

export interface TmuxNotificationEventData {
  source: NotificationSource;
  title?: string;
  body: string;
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  paneUrl?: string;
  paneTitle?: string;
  paneCurrentCommand?: string;
}

export type TmuxEventType =
  | 'window-add'
  | 'window-close'
  | 'window-renamed'
  | 'window-active'
  | 'pane-add'
  | 'pane-close'
  | 'pane-active'
  | 'layout-change'
  | 'bell'
  | 'notification'
  | 'output';

export type DeviceEventType = 'tmux-missing' | 'disconnected' | 'error' | 'reconnected';
