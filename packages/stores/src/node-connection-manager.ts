// 每 node 一套运行时：`get(nodeId)` 懒建 { connection, apiClient, appRuntime }，
// 引用计数归零后宽限 30 s 再释放（路由来回切换不重建连接）。standalone 下只有 `self`。
//
// - WS：`createGatewayConnection({ wsUrl: nodeWsUrl(id) })`，self → `/ws`，其余 → `/n/<id>/ws`。
// - REST：`new ApiClient(nodePathPrefix(id))`，端点函数照旧传 `/api/...`。
// - storage：agent / file-tree 等 key 带 node 前缀；UI 偏好（主题、侧栏、终端字号）是
//   宿主级偏好，所有 node 共用同一个 UIStore（key 仍为 `tmex-ui`）。
// - 路由：host.appPath 注入 `/n/<id>` 前缀，包内构造的应用内路径与 matchPath pattern 一并生效。

import {
  type ApiClient,
  SELF_NODE_ID,
  createNodeApiClient,
  nodeAppPath,
  nodeWsUrl,
  normalizeNodeId,
} from '@tmex/api-client';
import type { NotificationSink } from '@tmex/notifications';
import { type GatewayConnection, createGatewayConnection } from '@tmex/ws-client';
import { useEffect } from 'react';
import { type AppRuntime, createAppRuntime } from './app-runtime';
import { type AppRuntimeOptions, createBrowserHostServices } from './runtime';
import { type UIStore, createUIStore } from './ui';

export { SELF_NODE_ID, normalizeNodeId } from '@tmex/api-client';

/** 引用计数归零后的默认释放宽限期 */
export const DEFAULT_RELEASE_GRACE_MS = 30_000;

/** localStorage key 前缀：self 沿用旧 key（无前缀），其余按 node 隔离。 */
export function nodeStoragePrefix(nodeId: string): string {
  const id = normalizeNodeId(nodeId);
  return id === SELF_NODE_ID ? '' : `n:${id}:`;
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
  /** 测试注入点 */
  createConnection?: (nodeId: string) => GatewayConnection;
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

  private create(nodeId: string): EntryRecord {
    const connection =
      this.options.createConnection?.(nodeId) ??
      createGatewayConnection({ wsUrl: nodeWsUrl(nodeId) });
    const apiClient = this.options.createApiClient?.(nodeId) ?? createNodeApiClient(nodeId);

    const runtimeOptions: AppRuntimeOptions = {
      nodeId,
      connection,
      apiClient,
      storagePrefix: nodeStoragePrefix(nodeId),
      uiStore: this.uiStore(),
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
