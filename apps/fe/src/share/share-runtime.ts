// 被分享页的独立运行时：一条专用 WS + 一份只服务本页的 store 与查询缓存。
//
// 与常规页面的三处不同：
//   1. features 关掉 agent / watch / files 并打上 shareViewer 标记；
//   2. host.appPath 把包内构造的 pane 路径映射回分享页自身（见 ./share-route），
//      host.navigate 直接吞掉——访客不该被带去任何设备/节点地址；
//   3. 控制台顺带发起的几条常规查询（设备列表、终端快捷键、文件授权根）分享凭证一概
//      访问不到，预置成空值 / 空实现，免得每次进页面都白撞一发 401。

import { QueryClient } from '@tanstack/react-query';
import {
  createNodeApiClient,
  createNodeWsUrlSource,
  devicesQueryKey,
  nodeWsUrl,
  terminalShortcutsQueryKey,
} from '@tmex/api-client';
import { DEFAULT_TERMINAL_SHORTCUTS, type TerminalShortcutSettings } from '@tmex/shared';
import {
  type AppRuntime,
  type TerminalFileLinksProvider,
  type UIStore,
  createAppRuntime,
  createBrowserHostServices,
} from '@tmex/stores';
import { type GatewayConnection, createGatewayConnection } from '@tmex/ws-client';
import { createShareAppPath, sharePagePath } from './share-route';

/** 会话失效 / 分享结束的 WS 关闭码（契约见 plan §2.4）。 */
export const SHARE_WS_ENDED_CODE = 4410;
export const SHARE_WS_LOGIN_REQUIRED_CODE = 4401;

/**
 * 握手上声明本页绑定的分享：`/ws?cid=<nonce>&share=<shareId>`。
 *
 * 浏览器给不了自定义请求头，cookie 又是按 `tmex_sh_<via>` 单槽存的——同一个 node 上打开
 * 两个分享，后登录的那个会覆盖前一个的 cookie。不在握手里点名 shareId，服务端就只能
 * 「有什么凭证用什么」：已登录的浏览器会拿常规会话直接进（拿到全量设备元数据、撤销
 * 分享也踢不掉），两个分享互串时旧页面还会悄悄绑到新分享的权限与生命周期上。
 * 带上这个参数后服务端必须校验凭证与之匹配，不匹配即 4401。
 */
export const SHARE_WS_QUERY_PARAM = 'share';

/** 给 ws URL 追加分享参数；`createNodeWsUrlSource` 已经拼了 `?cid=`，这里只补一段。 */
export function withShareWsParam(url: string, shareId: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${SHARE_WS_QUERY_PARAM}=${encodeURIComponent(shareId)}`;
}

export interface ShareRuntimeOptions {
  nodeId: string;
  shareId: string;
  /** 宿主共用的 UI 偏好 store（主题 / 字号 / 输入模式）；不传则本页自建一份 */
  uiStore?: UIStore;
  /** 底层 socket 的关闭码回调；4410 / 4401 由页面处理 */
  onClose(code: number): void;
}

export interface ShareRuntimeHandle {
  runtime: AppRuntime;
  connection: GatewayConnection;
  queryClient: QueryClient;
  /** 停掉重连并释放整套运行时 */
  dispose(): void;
}

// 快捷键栏对手机上的访客很有用，而 `/api/settings/terminal-shortcuts` 分享凭证访问不到：
// 直接用内置默认表（send 类走 TERM_INPUT，paste 是本地动作，都在白名单内）。
const SHARE_SHORTCUTS: TerminalShortcutSettings = {
  items: DEFAULT_TERMINAL_SHORTCUTS,
  useIcons: false,
  updatedAt: new Date(0).toISOString(),
};

/** 分享页用不到的文件链接面：识别与跳转整体停用，不发任何 files 请求。 */
const NO_FILE_LINKS: TerminalFileLinksProvider = {
  listRoots: () => Promise.resolve([]),
  stat: () => Promise.reject(new Error('file links disabled for share viewers')),
  openFile: () => undefined,
};

function createShareQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Number.POSITIVE_INFINITY, retry: false, refetchOnWindowFocus: false },
    },
  });
  client.setQueryData(devicesQueryKey, { devices: [] });
  client.setQueryData(terminalShortcutsQueryKey, SHARE_SHORTCUTS);
  return client;
}

/** 分享连接的终态关闭码：重连只会被原样再关一次，必须就地停掉。 */
export function isShareTerminalCloseCode(code: number): boolean {
  return code === SHARE_WS_ENDED_CODE || code === SHARE_WS_LOGIN_REQUIRED_CODE;
}

export function createShareRuntime(options: ShareRuntimeOptions): ShareRuntimeHandle {
  const wsUrls = createNodeWsUrlSource(options.nodeId);
  // 终态关闭码要**同步**停掉重连：`handleClose` 紧跟着这个回调执行，等 React 提交完
  // 卸载再停就已经排上了一次重连（与 NodeConnectionManager 处理 4401 的做法一致）。
  let socket: GatewayConnection | null = null;
  const connection = createGatewayConnection({
    wsUrl: withShareWsParam(nodeWsUrl(options.nodeId), options.shareId),
    // 初次连接与每一次重连都走这里，分享参数因此不会在重连后掉。
    wsUrlFactory: () => withShareWsParam(wsUrls.nextUrl(), options.shareId),
    onClose: (code) => {
      if (isShareTerminalCloseCode(code)) socket?.client.disconnect();
      options.onClose(code);
    },
  });
  socket = connection;

  const base = sharePagePath(options.nodeId, options.shareId);
  const runtime = createAppRuntime({
    nodeId: options.nodeId,
    connection,
    apiClient: createNodeApiClient(options.nodeId),
    storagePrefix: `share:${options.shareId}:`,
    ...(options.uiStore ? { uiStore: options.uiStore } : {}),
    // 分享连接收不到 SITE_THEME_UPDATE / SETTINGS_UPDATE，站点设置也拉不到，
    // 浏览器级偏好（语言、外观）一律不由本运行时改写。
    controlsBrowserPrefs: false,
    host: {
      ...createBrowserHostServices({
        nodeId: options.nodeId,
        appPath: createShareAppPath(base),
      }),
      navigate: () => undefined,
    },
    features: { agentUi: false, watchUi: false, filesUi: false, shareViewer: true },
    terminalFileLinks: NO_FILE_LINKS,
  });

  return {
    runtime,
    connection,
    queryClient: createShareQueryClient(),
    dispose() {
      connection.client.disconnect();
      runtime.dispose();
      connection.dispose();
    },
  };
}
