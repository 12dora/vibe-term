// React 绑定：按子树注入 AppRuntime + 各 store 的 context 便捷 hook。
// terminal-ui / panels 经这些 hook 消费 store，保证多实例宿主下经 RuntimeProvider
// 注入的 runtime 生效，而非绑死默认单例（缺省 context 值即默认 runtime，开源 fe 零改动）。

import { type ReactNode, createContext, useContext } from 'react';
import type { AgentState } from './agent';
import type { AppRuntime } from './app-runtime';
import { defaultRuntime } from './default-runtime';
import type { FileTreeState } from './file-tree';
import type { SiteState } from './site';
import type { TmuxState } from './tmux';
import type { UIState } from './ui';
import { type PaneAgentState, selectPaneAgentState } from './use-pane-agent-state';

const RuntimeContext = createContext<AppRuntime>(defaultRuntime);

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
