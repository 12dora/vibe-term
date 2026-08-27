// React 绑定：按子树注入 AppRuntime + 各 store 的 context 便捷 hook。
// terminal-ui / panels 经这些 hook 消费 store。多 node 宿主每个 `/n/:nodeId` 边界注入
// 各自的 runtime；context 没有缺省 runtime，漏包 Provider 直接抛错而不是静默落到别的 node。

import { type ReactNode, createContext, useContext } from 'react';
import type { AgentState } from './agent';
import type { AppRuntime } from './app-runtime';
import type { FileTreeState } from './file-tree';
import type { SiteState } from './site';
import type { TmuxState } from './tmux';
import type { UIState } from './ui';
import { type PaneAgentState, selectPaneAgentState } from './use-pane-agent-state';

const RuntimeContext = createContext<AppRuntime | null>(null);

export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime;
  children: ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
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

export function usePaneAgentState(deviceId: string, paneId: string): PaneAgentState {
  const agentStore = useRuntime().stores.agent;
  return agentStore((state) => selectPaneAgentState(state, deviceId, paneId));
}
