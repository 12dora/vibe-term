// React 绑定：按子树注入 AppRuntime + 各 store 的 context 便捷 hook。
// terminal-ui / panels 经这些 hook 消费 store。多 node 宿主每个 `/n/:nodeId` 边界注入
// 各自的 runtime；context 没有缺省 runtime，漏包 Provider 直接抛错而不是静默落到别的 node。

import { Fragment, type ReactNode, createContext, useContext } from 'react';
import type { AgentState } from './agent';
import { resolveAgentStore } from './agent-host-store';
import { normalizeAgentNodeId } from './agent-session-map';
import type { AppRuntime } from './app-runtime';
import type { FileTreeState } from './file-tree';
import type { SiteState } from './site';
import type { TmuxState } from './tmux';
import type { UIState } from './ui';
import { type PaneAgentState, selectPaneAgentState } from './use-pane-agent-state';

const RuntimeContext = createContext<AppRuntime | null>(null);

const subtreeKeys = new WeakMap<AppRuntime, string>();
let subtreeKeySeq = 0;

/**
 * 一个 runtime 实例对应一把稳定的重挂 key；换了 runtime 实例就换 key。
 *
 * 宿主换 runtime（`/n/A/*` → `/n/B/*`，或旧路由 → `/n/B/*`）时 React Router 复用同一棵
 * 组件树，Provider 只是换了 context 值，子树整体保持挂载。但子树里按 runtime 建立的订阅
 * 并不都跟着 context 走：`@tanstack/react-query` 的 `useBaseQuery` 用 `useState` 在**首次
 * 挂载**时把 QueryObserver 和当时的 QueryClient 绑死，之后只 `setOptions`，永远不换 client。
 * 于是换 node 后这些 observer 继续读**上一个 node** 的缓存——设备列表还是旧 node 的，而
 * 连接意图与 tmux store 已经是新 node 的，两者对账时会就同一台设备反复 connect / disconnect，
 * 最终撞上 React 的更新深度上限（error #185）。
 *
 * 因此约定：runtime 换人即子树整体重挂，所有按 runtime 建立的订阅（query observer、store
 * 订阅、终端实例）随旧 runtime 一起卸载，不跨 node 残留。
 */
export function runtimeSubtreeKey(runtime: AppRuntime): string {
  let key = subtreeKeys.get(runtime);
  if (key === undefined) {
    subtreeKeySeq += 1;
    key = `${runtime.nodeId}#${subtreeKeySeq}`;
    subtreeKeys.set(runtime, key);
  }
  return key;
}

export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime;
  children: ReactNode;
}) {
  return (
    <RuntimeContext.Provider value={runtime}>
      <Fragment key={runtimeSubtreeKey(runtime)}>{children}</Fragment>
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error('useRuntime must be used within <RuntimeProvider>');
  }
  return runtime;
}

/** 可选读取：宿主外壳里 Provider 之外的组件用（无 Provider 返回 null）。 */
export function useOptionalRuntime(): AppRuntime | null {
  return useContext(RuntimeContext);
}

export function useTmuxStore<T>(selector: (state: TmuxState) => T): T {
  return useRuntime().stores.tmux(selector);
}

export function useUIStore<T>(selector: (state: UIState) => T): T {
  return useRuntime().stores.ui(selector);
}

export function useSiteStore<T>(selector: (state: SiteState) => T): T {
  return useRuntime().stores.site(selector);
}

export function useAgentStore<T>(selector: (state: AgentState) => T): T {
  return useRuntime().stores.agent(selector);
}

export function useFileTreeStore<T>(selector: (state: FileTreeState) => T): T {
  return useRuntime().stores.fileTree(selector);
}

/**
 * 分屏 pane 的 agent 徽标。会话由 entry 网关统一持有（`resolveAgentStore`），
 * 所以 `/n/:nodeId` 路由下也得读那一份 store，再按本 runtime 的 nodeId 过滤。
 */
export function usePaneAgentState(deviceId: string, paneId: string): PaneAgentState {
  const runtime = useRuntime();
  const agentStore = resolveAgentStore(runtime.stores.agent);
  const nodeId = normalizeAgentNodeId(runtime.nodeId);
  return agentStore((state) => selectPaneAgentState(state, deviceId, paneId, nodeId));
}
