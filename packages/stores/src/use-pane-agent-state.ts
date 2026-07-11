import type { AgentState } from './agent';
import { defaultRuntime } from './default-runtime';

export type PaneAgentState = 'none' | 'bound' | 'generating';

/**
 * 给定的 deviceId + paneId 是否有活跃 agent session 绑定。
 * - 'none'：无 session 或 session 状态为 stopped/error
 * - 'bound'：session 状态为 idle 或 waiting_confirmation
 * - 'generating'：session 状态为 running（流式输出中）
 */
export function selectPaneAgentState(
  state: AgentState,
  deviceId: string,
  paneId: string
): PaneAgentState {
  for (const session of Object.values(state.sessions)) {
    if (!session || session.deviceId !== deviceId || session.paneId !== paneId) continue;
    if (session.status === 'stopped' || session.status === 'error') continue;
    if (session.status === 'running') {
      const prog = state.inProgress[session.id];
      if (
        prog &&
        (prog.texts.length > 0 || prog.toolCalls.length > 0 || prog.reasonings.length > 0)
      ) {
        return 'generating';
      }
      return 'generating';
    }
    return 'bound';
  }
  return 'none';
}

// 默认 runtime 版（单实例宿主）；context 版见 ./react（多实例宿主经 RuntimeProvider）
export function usePaneAgentState(deviceId: string, paneId: string): PaneAgentState {
  return defaultRuntime.stores.agent((state) => selectPaneAgentState(state, deviceId, paneId));
}
