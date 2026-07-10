// 应用运行时：把连接、REST 客户端、通知出口、宿主服务与各 store 按实例组装。
// 单实例宿主使用默认 runtime（index.ts 原名导出）；多实例宿主每个 gateway 建一份。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import {
  type BellPlayer,
  type NotificationSink,
  noopNotificationSink,
  playBellSound,
} from '@tmex/notifications';
import type { TranslateFn } from '@tmex/notifications';
import {
  type BorshWebSocketClient,
  type GatewayConnection,
  type SelectCallbacks,
  type SelectStateMachine,
  getBorshClient,
  getSelectStateMachine,
} from '@tmex/ws-client';
import {
  type PaneSink,
  beginPaneHistoryGate,
  cleanupDevicePaneState,
  dispatchPaneApplyHistory,
  dispatchPaneHistory,
  dispatchPaneOutput,
  dispatchPaneReset,
  registerPaneSink,
} from '@tmex/ws-client/pane-sink-registry';
import i18next from 'i18next';
import { bridgeCloseMobileSidebar, bridgeIsMobile, bridgeOpenMobileSidebar } from './flow-bridges';
import type { UIStore } from './ui';

export interface HostServices {
  /** 应用内跳转（toast/通知点击等），语义等同 navigateToAppUrl */
  navigate(to: string, opts?: { replace?: boolean }): void;
  /**
   * 把包内构造的应用内路径（如 /devices/…、/file/…）映射为宿主路由形状；缺省恒等。
   * 必须是纯路径前缀变换（同一实现也会用于 matchPath pattern）。
   */
  appPath?(path: string): string;
  isMobile(): boolean;
  openMobileSidebar(): void;
  closeMobileSidebar(): void;
}

/** pane 输出路由面（默认绑模块级注册表，多实例绑各自 PaneSinkRegistry） */
export interface PaneSinkRouting {
  /** 终端组件挂载时注册 sink，返回注销函数（消费侧，与 dispatch 生产侧同一注册表） */
  registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void;
  dispatchPaneReset(deviceId: string, paneId: string, origin?: 'select' | 'history-refresh'): void;
  dispatchPaneApplyHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void;
  dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void;
  dispatchPaneHistory(
    deviceId: string,
    paneId: string,
    token: Uint8Array,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): boolean;
  beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void;
  cleanupDevicePaneState(deviceId: string): void;
}

export interface AppRuntimeOptions {
  /** 按连接组装的 WS 面；缺省绑各模块默认单例 */
  connection?: GatewayConnection;
  apiClient?: ApiClient;
  notifications?: NotificationSink;
  bell?: BellPlayer;
  t?: TranslateFn;
  host?: HostServices;
  /** localStorage persist key 前缀；缺省空（与既有 key 完全一致） */
  storagePrefix?: string;
  /** 宿主共享的 UI 偏好 store（多 runtime 并存时传同一实例）；缺省按 storagePrefix 新建 */
  uiStore?: UIStore;
  /** UI 能力开关；缺省全开（单实例宿主零变化） */
  features?: { agentUi?: boolean };
}

/** 已解析的 UI 能力开关 */
export interface RuntimeFeatures {
  agentUi: boolean;
}

/** store 工厂消费的已解析服务面 */
export interface RuntimeCore {
  client: BorshWebSocketClient;
  selectMachine(callbacks?: SelectCallbacks): SelectStateMachine;
  paneSinks: PaneSinkRouting;
  apiClient: ApiClient;
  notifications: NotificationSink;
  bell: BellPlayer;
  t: TranslateFn;
  host: HostServices;
  storagePrefix: string;
  features: RuntimeFeatures;
}

const defaultHost: HostServices = {
  navigate(to, opts) {
    // 延迟 import 防环（app-navigation → flow-bridges 已在包内）
    void opts;
    navigateViaAppNavigation(to);
  },
  isMobile: bridgeIsMobile,
  openMobileSidebar: bridgeOpenMobileSidebar,
  closeMobileSidebar: bridgeCloseMobileSidebar,
};

// navigateToAppUrl 定义在 app-navigation.ts；直接 import 会与 runtime 无环（app-navigation 不依赖 runtime）
import { navigateToAppUrl as navigateViaAppNavigation } from './app-navigation';

// 默认通知出口：可变引用代理，宿主启动时注入实现（fe 注入 sonner 适配器）。
// 代理形态保证「先建默认 runtime、后注入实现」的顺序也能生效。
const defaultSinkRef: { current: NotificationSink } = { current: noopNotificationSink };

export function setDefaultNotificationSink(sink: NotificationSink): void {
  defaultSinkRef.current = sink;
}

export const proxyDefaultNotificationSink: NotificationSink = {
  info: (title, options) => defaultSinkRef.current.info(title, options),
  success: (title, options) => defaultSinkRef.current.success(title, options),
  warning: (title, options) => defaultSinkRef.current.warning(title, options),
  error: (title, options) => defaultSinkRef.current.error(title, options),
};

const defaultBell: BellPlayer = { play: playBellSound };

const defaultPaneSinks: PaneSinkRouting = {
  registerPaneSink,
  dispatchPaneReset,
  dispatchPaneApplyHistory,
  dispatchPaneOutput,
  dispatchPaneHistory,
  beginPaneHistoryGate,
  cleanupDevicePaneState,
};

export function resolveRuntimeCore(options: AppRuntimeOptions = {}): RuntimeCore {
  const conn = options.connection;
  return {
    // 默认路径惰性求值：与拆包前「逐调用点 getBorshClient()」语义一致（含测试 mock 的 live binding）
    get client() {
      return conn?.client ?? getBorshClient();
    },
    selectMachine: conn
      ? (callbacks) => {
          if (callbacks) conn.selectMachine.setCallbacks(callbacks);
          return conn.selectMachine;
        }
      : (callbacks) => getSelectStateMachine(callbacks),
    paneSinks: conn
      ? {
          registerPaneSink: (d, p, sink) => conn.paneSinks.registerPaneSink(d, p, sink),
          dispatchPaneReset: (d, p, o) => conn.paneSinks.dispatchPaneReset(d, p, o),
          dispatchPaneApplyHistory: (d, p, data, alt, m) =>
            conn.paneSinks.dispatchPaneApplyHistory(d, p, data, alt, m),
          dispatchPaneOutput: (d, p, data) => conn.paneSinks.dispatchPaneOutput(d, p, data),
          dispatchPaneHistory: (d, p, tok, data, alt, m) =>
            conn.paneSinks.dispatchPaneHistory(d, p, tok, data, alt, m),
          beginPaneHistoryGate: (d, p, tok) => conn.paneSinks.beginPaneHistoryGate(d, p, tok),
          cleanupDevicePaneState: (d) => conn.paneSinks.cleanupDevicePaneState(d),
        }
      : defaultPaneSinks,
    apiClient: options.apiClient ?? defaultApiClient,
    notifications: options.notifications ?? proxyDefaultNotificationSink,
    bell: options.bell ?? defaultBell,
    t: options.t ?? ((key, params) => String(i18next.t(key, params as never))),
    host: options.host ?? defaultHost,
    storagePrefix: options.storagePrefix ?? '',
    features: { agentUi: options.features?.agentUi ?? true },
  };
}

/** 包内 URL 构造统一经此映射到宿主路由形状（缺省恒等） */
export function hostAppPath(host: HostServices, path: string): string {
  return host.appPath ? host.appPath(path) : path;
}
