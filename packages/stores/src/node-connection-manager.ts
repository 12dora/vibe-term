// 每 node 一套运行时：`get(nodeId)` 懒建 { connection, apiClient, appRuntime }，
// 引用计数归零后宽限 30 s 再释放（路由来回切换不重建连接）。standalone 下只有 `self`。
//
// - WS：`createGatewayConnection({ wsUrl: nodeWsUrl(id) })`，self → `/ws`，其余 → `/n/<id>/ws`；
//   每条 socket 另带一个 client nonce `?cid=`（见 `createDefaultNodeConnection`）。
// - REST：`new ApiClient(nodePathPrefix(id))`，端点函数照旧传 `/api/...`。
// - storage：agent / file-tree 等 key 带 node 前缀；UI 偏好（主题、侧栏、终端字号）是
//   宿主级偏好，所有 node 共用同一个 UIStore（key 仍为 `tmex-ui`）。
// - 路由：host.appPath 注入 `/n/<id>` 前缀，包内构造的应用内路径与 matchPath pattern 一并生效。

import {
  type ApiClient,
  SELF_NODE_ID,
  createNodeApiClient,
  createNodeWsUrlSource,
  nodeAppPath,
  nodeWsUrl,
  normalizeNodeId,
} from '@tmex/api-client';
import {
  handleGlobalUnauthorized,
  handleNodeLoginRequired,
} from '@tmex/api-client/auth/session-interceptor';
import type { NotificationSink } from '@tmex/notifications';
import {
  type GatewayConnection,
  type SocketFactory,
  createGatewayConnection,
} from '@tmex/ws-client';
import { useEffect } from 'react';
import { type AppRuntime, createAppRuntime } from './app-runtime';
import { type AppRuntimeOptions, createBrowserHostServices } from './runtime';
import { type UIStore, createUIStore } from './ui';

export { SELF_NODE_ID, normalizeNodeId } from '@tmex/api-client';

/** 引用计数归零后的默认释放宽限期 */
export const DEFAULT_RELEASE_GRACE_MS = 30_000;

/** 会话在连接期间失效时服务端的关闭码（B2-2b 契约：`/ws`、`/n/:id/ws`、`/mesh/ws` 一致）。 */
export const WS_UNAUTHORIZED_CLOSE_CODE = 4401;

/** localStorage key 前缀：self 沿用旧 key（无前缀），其余按 node 隔离。 */
export function nodeStoragePrefix(nodeId: string): string {
  const id = normalizeNodeId(nodeId);
  return id === SELF_NODE_ID ? '' : `n:${id}:`;
}

/**
 * manager 的缺省连接工厂（宿主没覆盖 `createConnection` 时走这条）。
 *
 * 每条底层 socket（含**重连**新建的那条）都带一个新的 client nonce `?cid=`：浏览器不能给
 * WS 设请求头，node 只能靠握手 URL 上的 nonce 把这条 WS 认出来，随后
 * `GET /api/mesh/connection?cid=` 才换得到服务端 `connectionId`。
 */
export function createDefaultNodeConnection(
  nodeId: string,
  onClose: (code: number) => void,
  socketFactory?: SocketFactory
): GatewayConnection {
  const wsUrls = createNodeWsUrlSource(nodeId);
  return createGatewayConnection({
    wsUrl: nodeWsUrl(nodeId),
    wsUrlFactory: () => wsUrls.nextUrl(),
    onClose,
    ...(socketFactory ? { socketFactory } : {}),
  });
}

export interface NodeRuntimeEntry {
  nodeId: string;
  connection: GatewayConnection;
  apiClient: ApiClient;
  runtime: AppRuntime;
}

export interface NodeConnectionManagerOptions {
  /** 引用计数归零到 dispose 的宽限期，缺省 30 s */
  graceMs?: number;
  /** 宿主按 node 附加的 runtime 选项（notifications / features / terminalFileLinks 等） */
  runtimeOptions?: (nodeId: string) => AppRuntimeOptions;
  /** 全部 node 共用的通知出口（宿主只有一个 toaster） */
  notifications?: NotificationSink;
  /** runtime 真正被回收时的回调（宿主据此释放该 node 的 QueryClient 等外挂资源）。 */
  onDispose?: (nodeId: string) => void;
  /** WS 4401 的处理（测试注入）；缺省派发全局 / 单 node 的鉴权事件。 */
  onUnauthorized?: (nodeId: string) => void;
  /**
   * 宿主自建连接（如 fe 的直连包装）。
   *
   * `onClose` 是**必传给底层连接**的关闭码回调：自建工厂绕过了下面的默认工厂，不把它接到
   * 真正的 socket 上，4401 就没有人处理，ws-client 会一直重连到被反复关掉
   * （见 F4-fix 评审 Major）。因此这里由 manager 主动把回调递给工厂，工厂没有借口忘记它。
   */
  createConnection?: (nodeId: string, onClose: (code: number) => void) => GatewayConnection;
  createApiClient?: (nodeId: string) => ApiClient;
  createRuntime?: (options: AppRuntimeOptions) => AppRuntime;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface EntryRecord {
  entry: NodeRuntimeEntry;
  refs: number;
  disposeHandle: unknown;
}

export class NodeConnectionManager {
  private readonly records = new Map<string, EntryRecord>();
  private sharedUiStore: UIStore | null = null;

  constructor(private readonly options: NodeConnectionManagerOptions = {}) {}

  private get graceMs(): number {
    return this.options.graceMs ?? DEFAULT_RELEASE_GRACE_MS;
  }

  private schedule(fn: () => void, ms: number): unknown {
    return (this.options.setTimeoutFn ?? ((cb, delay) => setTimeout(cb, delay)))(fn, ms);
  }

  private cancel(handle: unknown): void {
    (this.options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(
      handle
    );
  }

  /** 所有 node 共用的 UI 偏好 store（key 恒为 `tmex-ui`，与单 node 时一致）。 */
  private uiStore(): UIStore {
    if (!this.sharedUiStore) this.sharedUiStore = createUIStore({ storagePrefix: '' });
    return this.sharedUiStore;
  }

  /**
   * WS 以 4401 关闭 = 该 node 的会话已失效。继续重连只会被反复关掉，所以先停连接，
   * 再按 self / 目标 node 派发一次鉴权事件：self → 全局跳登录页；其余 → 该行显示「登录此节点」。
   */
  /** 宿主自建连接（如 fe 的直连包装）时把关闭码转回来，走同一条 4401 处理路径。 */
  notifyClose(nodeId: string, code: number): void {
    if (code === WS_UNAUTHORIZED_CLOSE_CODE) this.handleUnauthorized(normalizeNodeId(nodeId));
  }

  private handleUnauthorized(nodeId: string): void {
    const record = this.records.get(nodeId);
    record?.entry.connection.client.disconnect();
    if (this.options.onUnauthorized) {
      this.options.onUnauthorized(nodeId);
      return;
    }
    if (nodeId === SELF_NODE_ID) handleGlobalUnauthorized('/ws');
    else handleNodeLoginRequired(nodeId, nodeWsUrl(nodeId));
  }

  private create(nodeId: string): EntryRecord {
    const onClose = (code: number) => this.notifyClose(nodeId, code);
    const connection =
      this.options.createConnection?.(nodeId, onClose) ??
      createDefaultNodeConnection(nodeId, onClose);
    const apiClient = this.options.createApiClient?.(nodeId) ?? createNodeApiClient(nodeId);

    const runtimeOptions: AppRuntimeOptions = {
      nodeId,
      connection,
      apiClient,
      storagePrefix: nodeStoragePrefix(nodeId),
      uiStore: this.uiStore(),
      // 全局 i18n 语言只由 entry 自身的站点设置驱动；远端 node 的站点语言留在它自己的 store 里。
      controlsBrowserPrefs: nodeId === SELF_NODE_ID,
      host: createBrowserHostServices({
        nodeId,
        appPath: (path) => nodeAppPath(nodeId, path),
      }),
      ...(this.options.notifications ? { notifications: this.options.notifications } : {}),
      ...this.options.runtimeOptions?.(nodeId),
    };

    const runtime = (this.options.createRuntime ?? createAppRuntime)(runtimeOptions);
    return {
      entry: { nodeId, connection, apiClient, runtime },
      refs: 0,
      disposeHandle: null,
    };
  }

  private record(nodeId: string): EntryRecord {
    const id = normalizeNodeId(nodeId);
    let record = this.records.get(id);
    if (!record) {
      record = this.create(id);
      this.records.set(id, record);
      // 只 get 未 acquire 的 runtime（未提交的渲染）同样受宽限期保护，不会泄漏。
      record.disposeHandle = this.schedule(() => this.dispose(id), this.graceMs);
    }
    return record;
  }

  /** 懒建并返回该 node 的运行时；不改变引用计数。 */
  get(nodeId: string): NodeRuntimeEntry {
    return this.record(nodeId).entry;
  }

  /** 取用（引用计数 +1，取消待释放）。 */
  acquire(nodeId: string): NodeRuntimeEntry {
    const record = this.record(nodeId);
    if (record.disposeHandle !== null) {
      this.cancel(record.disposeHandle);
      record.disposeHandle = null;
    }
    record.refs += 1;
    return record.entry;
  }

  /** 归还（引用计数 -1）；归零后宽限期结束才真正 dispose。 */
  release(nodeId: string): void {
    const id = normalizeNodeId(nodeId);
    const record = this.records.get(id);
    if (!record) return;
    record.refs = Math.max(0, record.refs - 1);
    if (record.refs > 0 || record.disposeHandle !== null) return;
    record.disposeHandle = this.schedule(() => this.dispose(id), this.graceMs);
  }

  refCount(nodeId: string): number {
    return this.records.get(normalizeNodeId(nodeId))?.refs ?? 0;
  }

  has(nodeId: string): boolean {
    return this.records.has(normalizeNodeId(nodeId));
  }

  list(): NodeRuntimeEntry[] {
    return [...this.records.values()].map((record) => record.entry);
  }

  /** 立即释放（引用计数 > 0 时不释放，避免误杀正在使用的 runtime）。 */
  dispose(nodeId: string): void {
    const id = normalizeNodeId(nodeId);
    const record = this.records.get(id);
    if (!record) return;
    if (record.disposeHandle !== null) {
      this.cancel(record.disposeHandle);
      record.disposeHandle = null;
    }
    if (record.refs > 0) return;
    this.records.delete(id);
    record.entry.runtime.dispose();
    record.entry.connection.dispose();
    this.options.onDispose?.(id);
  }

  disposeAll(): void {
    for (const [id, record] of [...this.records.entries()]) {
      record.refs = 0;
      this.dispose(id);
    }
    this.records.clear();
  }
}

/** 宿主全局实例（浏览器只有一套页面） */
export const nodeRuntimes = new NodeConnectionManager();

/**
 * 取用某 node 的运行时：渲染期懒建，挂载期 acquire、卸载期 release。
 * `nodeId` 缺省或为空即 `self`。
 */
export function useNodeRuntime(
  nodeId: string | undefined,
  manager: NodeConnectionManager = nodeRuntimes
): AppRuntime {
  const id = normalizeNodeId(nodeId);
  const entry = manager.get(id);

  useEffect(() => {
    manager.acquire(id);
    return () => manager.release(id);
  }, [manager, id]);

  return entry.runtime;
}
