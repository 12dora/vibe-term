// 应用运行时：把连接、REST 客户端、通知出口、宿主服务与各 store 按实例组装。
// 单实例宿主使用默认 runtime（index.ts 原名导出）；多实例宿主每个 gateway 建一份。

import { type ApiClient, SELF_NODE_ID, defaultApiClient } from '@tmex/api-client';
import {
  type BellPlayer,
  type NotificationSink,
  noopNotificationSink,
  playBellSound,
} from '@tmex/notifications';
import type { TranslateFn } from '@tmex/notifications';
import { writeTextToClipboard } from '@tmex/shared';
import {
  type BorshWebSocketClient,
  type GatewayConnection,
  type GatewayPaneHistoryPage,
  type GatewayPaneScreenSnapshot,
  type GatewayRebaseReason,
  type GatewayTerminalData,
  type GatewayTransport,
  LazyWebSocketGatewayTransport,
  getBorshClient,
} from '@tmex/ws-client';
import {
  type PaneSink,
  cleanupDevicePaneState,
  dispatchPaneHistoryPage,
  dispatchPaneRebase,
  dispatchPaneScreenSnapshot,
  dispatchPaneTerminalData,
  registerPaneSink,
} from '@tmex/ws-client/pane-sink-registry';
import i18next from 'i18next';
import { bridgeCloseMobileSidebar, bridgeIsMobile, bridgeOpenMobileSidebar } from './flow-bridges';
import type { UIStore } from './ui';

export interface SaveFileInput {
  name: string;
  blob: Blob;
}

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
  /** 写入系统剪贴板；默认 Browser 实现含 Clipboard API + textarea/execCommand fallback */
  writeClipboardText(text: string): Promise<void>;
  /** 读取系统剪贴板文本 */
  readClipboardText(): Promise<string>;
  /** 打开外部 URL（新标签页/系统浏览器等）；可异步 */
  openExternal(url: string): void | Promise<void>;
  /** 整页/宿主刷新 */
  reload(): void | Promise<void>;
  /** 将已传输完成的文件交给宿主保存（默认 object URL + a[download]） */
  saveFile(file: SaveFileInput): void | Promise<void>;
}

/** 终端文件链接授权根：识别用绝对路径 + 打开文件时回传的定位 id */
export interface TerminalFileLinkRoot {
  id: string;
  path: string;
}

/**
 * 终端文件链接面：路径识别用的授权根、存在性校验与打开动作。
 * 缺省实现走 gateway 文件 API 与 /file/:ref 路由（Terminal 组件内落地）；
 * 文件子系统另有实现的宿主可整体替换。
 */
export interface TerminalFileLinksProvider {
  /** 该设备可用的授权根；空数组＝该设备不启用文件链接识别 */
  listRoots(deviceId: string): Promise<TerminalFileLinkRoot[]>;
  /** 存在性校验；文件不存在时 reject */
  stat(rootId: string, path: string): Promise<unknown>;
  /** 打开文件（宿主自行导航） */
  openFile(rootId: string, path: string): void;
}

/** pane 输出路由面（默认绑模块级注册表，多实例绑各自 PaneSinkRegistry） */
export interface PaneSinkRouting {
  /** 终端组件挂载时注册 sink，返回注销函数（消费侧，与 dispatch 生产侧同一注册表） */
  registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void;
  dispatchPaneTerminalData(frame: GatewayTerminalData): void;
  dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void;
  dispatchPaneHistoryPage(page: GatewayPaneHistoryPage): void;
  dispatchPaneRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void;
  cleanupDevicePaneState(deviceId: string): void;
}

export interface AppRuntimeOptions {
  /** 本 runtime 服务的 node；缺省 `self`（entry 自身 / standalone） */
  nodeId?: string;
  /** 按连接组装的 WS 面；缺省绑各模块默认单例 */
  connection?: GatewayConnection;
  /** 外部进程/页面持有的共享 state transport；不会创建 physical WebSocket。 */
  transport?: GatewayTransport;
  apiClient?: ApiClient;
  notifications?: NotificationSink;
  bell?: BellPlayer;
  t?: TranslateFn;
  host?: HostServices;
  /** localStorage persist key 前缀；缺省空（与既有 key 完全一致） */
  storagePrefix?: string;
  /** 宿主共享的 UI 偏好 store（多 runtime 并存时传同一实例）；缺省按 storagePrefix 新建 */
  uiStore?: UIStore;
  /**
   * 本 runtime 的站点设置是否驱动**全局** i18n 语言；缺省 true。
   * i18next 是浏览器级单例，多 node 宿主里只有 self / 宿主 runtime 允许为 true——
   * 远端 node 的站点语言（常常还是 en_US）不得把整页 UI 掀翻。
   */
  controlsBrowserPrefs?: boolean;
  /** UI 能力开关；缺省全开（单实例宿主零变化） */
  features?: {
    agentUi?: boolean;
    watchUi?: boolean;
    filesUi?: boolean;
    hostManagedNotifications?: boolean;
  };
  /** 终端文件链接面；缺省走 gateway 文件 API 与 /file/:ref 路由 */
  terminalFileLinks?: TerminalFileLinksProvider;
}

/** 已解析的 UI 能力开关 */
export interface RuntimeFeatures {
  agentUi: boolean;
  /** 终端监控（watch）UI：关断时不渲染 watch 入口与对话框，也不发起 watch 查询 */
  watchUi: boolean;
  /** 文件（files）UI：关断时不渲染文件面板与文件设置卡，也不发起 files 查询 */
  filesUi: boolean;
  /** 宿主接管通知呈现：终端 notification 不再由包内弹 toast（bell 声与高亮不受影响） */
  hostManagedNotifications: boolean;
}

/** store 工厂消费的已解析服务面 */
export interface RuntimeCore {
  /** 本 runtime 服务的 node（`self` 即 entry 自身）；URL / 事件 / 存储按它区分 */
  nodeId: string;
  client: BorshWebSocketClient;
  transport: GatewayTransport;
  paneSinks: PaneSinkRouting;
  apiClient: ApiClient;
  notifications: NotificationSink;
  bell: BellPlayer;
  t: TranslateFn;
  host: HostServices;
  storagePrefix: string;
  /** 本 runtime 的站点语言/外观是否写回浏览器级全局状态（i18next、<html>.dark、主题预设）；仅 self runtime 为 true */
  controlsBrowserPrefs: boolean;
  features: RuntimeFeatures;
  terminalFileLinks?: TerminalFileLinksProvider;
}

async function browserReadClipboard(): Promise<string> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    throw new Error('clipboard unavailable');
  }
  return navigator.clipboard.readText();
}

function browserOpenExternal(url: string): void {
  if (typeof window === 'undefined') {
    throw new Error('openExternal unavailable');
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function browserReload(): void {
  if (typeof window === 'undefined') {
    throw new Error('reload unavailable');
  }
  window.location.reload();
}

/** Browser 默认：object URL + a[download]，成功与失败路径均清理 object URL / DOM helper。 */
async function browserSaveFile(file: SaveFileInput): Promise<void> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('saveFile unavailable');
  }
  const objectUrl = URL.createObjectURL(file.blob);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export interface BrowserHostOptions {
  /** 本 host 所属 node；导航时随全局选择事件一并派发 */
  nodeId?: string;
  /** 包内构造的应用内路径前缀变换（多 node 宿主传 `/n/<id>` 前缀器） */
  appPath?(path: string): string;
}

/**
 * 浏览器宿主服务。多 node 宿主按 node 建一份并注入 appPath，使包内构造的
 * `/devices/…`、`/file/…` 路径与 matchPath pattern 一并带上 `/n/<id>` 前缀。
 */
export function createBrowserHostServices(options: BrowserHostOptions = {}): HostServices {
  const toAppPath = (path: string) => (options.appPath ? options.appPath(path) : path);
  return {
    // navigate 接收的一律是「已是宿主路由形状」的路径（调用方负责先过 hostAppPath），
    // 否则 watch / rsync 等已显式 hostAppPath 的调用点会被二次加前缀。
    navigate(to, opts) {
      void opts;
      navigateViaAppNavigation(to, options.nodeId ?? SELF_NODE_ID);
    },
    ...(options.appPath ? { appPath: toAppPath } : {}),
    isMobile: bridgeIsMobile,
    openMobileSidebar: bridgeOpenMobileSidebar,
    closeMobileSidebar: bridgeCloseMobileSidebar,
    writeClipboardText: writeTextToClipboard,
    readClipboardText: browserReadClipboard,
    openExternal: browserOpenExternal,
    reload: browserReload,
    saveFile: browserSaveFile,
  };
}

const defaultHost: HostServices = createBrowserHostServices();

// navigateToAppUrl 定义在 app-navigation.ts；直接 import 会与 runtime 无环（app-navigation 不依赖 runtime）
import { navigateToAppUrl as navigateViaAppNavigation } from './app-navigation';

const defaultBell: BellPlayer = { play: playBellSound };

const defaultPaneSinks: PaneSinkRouting = {
  registerPaneSink,
  dispatchPaneTerminalData,
  dispatchPaneScreenSnapshot,
  dispatchPaneHistoryPage,
  dispatchPaneRebase,
  cleanupDevicePaneState,
};

const defaultTranslate: TranslateFn = (key, params) => String(i18next.t(key, params as never));

/** transport 优先级：显式注入 > 连接自带 > 惰性 WS 回落（解析时不建 client） */
function resolveTransport(options: AppRuntimeOptions): GatewayTransport {
  const conn = options.connection;
  return (
    options.transport ??
    conn?.transport ??
    new LazyWebSocketGatewayTransport(() => conn?.client ?? getBorshClient())
  );
}

function connectionPaneSinks(conn: GatewayConnection): PaneSinkRouting {
  return {
    registerPaneSink: (d, p, sink) => conn.paneSinks.registerPaneSink(d, p, sink),
    dispatchPaneTerminalData: (frame) => conn.paneSinks.dispatchPaneTerminalData(frame),
    dispatchPaneScreenSnapshot: (snapshot) => conn.paneSinks.dispatchPaneScreenSnapshot(snapshot),
    dispatchPaneHistoryPage: (page) => conn.paneSinks.dispatchPaneHistoryPage(page),
    dispatchPaneRebase: (d, p, reason) => conn.paneSinks.dispatchPaneRebase(d, p, reason),
    cleanupDevicePaneState: (d) => conn.paneSinks.cleanupDevicePaneState(d),
  };
}

function resolveFeatures(features: AppRuntimeOptions['features']): RuntimeFeatures {
  return {
    agentUi: features?.agentUi ?? true,
    watchUi: features?.watchUi ?? true,
    filesUi: features?.filesUi ?? true,
    hostManagedNotifications: features?.hostManagedNotifications ?? false,
  };
}

export function resolveRuntimeCore(options: AppRuntimeOptions = {}): RuntimeCore {
  const conn = options.connection;
  return {
    nodeId: options.nodeId ?? SELF_NODE_ID,
    // 默认路径惰性求值：与拆包前「逐调用点 getBorshClient()」语义一致（含测试 mock 的 live binding）
    get client() {
      return conn?.client ?? getBorshClient();
    },
    transport: resolveTransport(options),
    paneSinks: conn ? connectionPaneSinks(conn) : defaultPaneSinks,
    apiClient: options.apiClient ?? defaultApiClient,
    notifications: options.notifications ?? noopNotificationSink,
    bell: options.bell ?? defaultBell,
    t: options.t ?? defaultTranslate,
    host: options.host ?? defaultHost,
    storagePrefix: options.storagePrefix ?? '',
    controlsBrowserPrefs: options.controlsBrowserPrefs ?? true,
    features: resolveFeatures(options.features),
    terminalFileLinks: options.terminalFileLinks,
  };
}

/** 包内 URL 构造统一经此映射到宿主路由形状（缺省恒等） */
export function hostAppPath(host: HostServices, path: string): string {
  return host.appPath ? host.appPath(path) : path;
}
