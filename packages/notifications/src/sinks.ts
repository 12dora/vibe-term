// 通知出口的语义接口：宿主注入具体实现（toast 库、系统通知、静默……），默认 no-op。
// 语义面刻意窄于任何具体 toast 库，避免实现细节泄漏进业务层。

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface NotificationOptions {
  description?: string;
  action?: NotificationAction;
  /** 展示时长（毫秒），实现可忽略 */
  duration?: number;
}

export interface NotificationSink {
  info(title: string, options?: NotificationOptions): void;
  success(title: string, options?: NotificationOptions): void;
  warning(title: string, options?: NotificationOptions): void;
  error(title: string, options?: NotificationOptions): void;
}

export const noopNotificationSink: NotificationSink = {
  info() {},
  success() {},
  warning() {},
  error() {},
};

export interface BellPlayer {
  play(): void;
}

export const noopBellPlayer: BellPlayer = {
  play() {},
};

export interface BrowserNotifier {
  /** 权限未授予或平台不支持时应静默降级 */
  notify(title: string, body: string, onClick?: () => void): void;
}

export const noopBrowserNotifier: BrowserNotifier = {
  notify() {},
};
