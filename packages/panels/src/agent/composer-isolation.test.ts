// 流式 delta flush 期间输入区不应重渲染：动作引用恒定 + 传给 AgentComposer 的 props 全是原始值，
// memo 的浅比较因此始终命中。bun test 无 DOM，这里用 React.memo 的浅比较语义直接判定；
// 依赖快照按 useAgentTabActions 的语义只在「提交」时写入，渲染本身不写。

import { describe, expect, test } from 'bun:test';

import type { AgentSessionDto } from '@tmex/shared';
import type { SessionInProgress } from '@tmex/stores';

import { AgentComposer } from './agent-composer';
import { deriveAgentTabView } from './agent-tab-view';
import {
  type AgentTabActionDeps,
  type AgentTabActions,
  createAgentTabActions,
} from './use-agent-tab-actions';
import type { AgentStoreHandle, AgentTabState } from './use-agent-tab-state';

const FLUSHES = 50;

function session(overrides: Partial<AgentSessionDto> = {}): AgentSessionDto {
  return {
    id: 's1',
    deviceId: 'd1',
    paneId: '%1',
    providerId: null,
    modelId: 'm1',
    writeMode: 'confirm',
    allowControlChars: false,
    status: 'running',
    lastError: null,
    ...overrides,
  } as AgentSessionDto;
}

function makeState(
  stopped: string[],
  activeSession: AgentSessionDto,
  inProgress: SessionInProgress | undefined
): AgentTabState {
  const agentStore = {
    getState: () => ({
      stopSession: (id: string) => {
        stopped.push(id);
      },
    }),
  } as unknown as AgentStoreHandle;
  return {
    agentStore,
    snapshots: {},
    nodeId: null,
    nodeOffline: undefined,
    devices: [{ id: 'd1', name: 'laptop' }],
    devicesLoading: false,
    devicesError: false,
    routeDeviceId: 'd1',
    routePaneId: '%1',
    routePaneTitle: 'vim',
    activeSessionId: activeSession.id,
    activeSession,
    draft: null,
    messages: [],
    inProgress,
    pendingConfirmations: undefined,
    sending: false,
    materializingDraft: false,
    queued: undefined,
    defaultWriteMode: 'confirm',
  } as unknown as AgentTabState;
}

function progress(chars: number): SessionInProgress {
  return {
    texts: [{ messageId: 'm', text: 'x'.repeat(chars), stale: false }],
    reasonings: [],
    toolCalls: [],
    staleBarrier: false,
  };
}

/** AgentTab 传给 AgentComposer 的 props（与 agent-tab.tsx 一致） */
function composerProps(state: AgentTabState, actions: AgentTabActions): Record<string, unknown> {
  const view = deriveAgentTabView(state);
  return {
    draftEmpty: view.draftEmpty,
    draftPrompt: view.draft?.prompt ?? null,
    disabled: view.inputDisabled,
    running: view.running,
    hasActiveSession: Boolean(view.activeSession),
    isOrphan: view.isOrphan,
    writeMode: view.writeMode,
    allowControlChars: view.allowControlChars,
    modelProviderId: view.modelProviderId,
    modelId: view.modelId,
    onSend: actions.onSend,
    onSteer: actions.onSteer,
    onStop: actions.onStop,
    onModelChange: actions.onModelChange,
    onWriteModeChange: actions.onWriteModeChange,
    onAllowControlCharsChange: actions.onAllowControlCharsChange,
  };
}

/** React.memo 默认比较：键集合相同且每个键 Object.is 相等 */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/** 一次渲染算出的依赖快照 */
function depsOf(state: AgentTabState): AgentTabActionDeps {
  return {
    state,
    view: deriveAgentTabView(state),
    navigate: (() => {}) as unknown as AgentTabActionDeps['navigate'],
    host: {} as AgentTabActionDeps['host'],
    setSidebarTab: () => {},
  };
}

/** 提交（useAgentTabActions 里的 layout effect）才把快照写进 ref */
function commit(ref: { current: AgentTabActionDeps }, state: AgentTabState): void {
  ref.current = depsOf(state);
}

describe('composer 与流式刷新的隔离', () => {
  test('AgentComposer 是 memo 组件', () => {
    expect((AgentComposer as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo')
    );
  });

  test('50 次 delta flush 后 composer props 一次都没变（即不重渲染）', () => {
    const stopped: string[] = [];
    const active = session();
    const deps = { current: {} as AgentTabActionDeps };

    commit(deps, makeState(stopped, active, undefined));
    const actions = createAgentTabActions(deps);
    const first = composerProps(deps.current.state, actions);

    let changed = 0;
    for (let i = 1; i <= FLUSHES; i += 1) {
      commit(deps, makeState(stopped, active, progress(i * 40)));
      if (!shallowEqual(first, composerProps(deps.current.state, actions))) changed += 1;
    }

    expect(changed).toBe(0);
  });

  test('动作引用恒定但始终作用于最新已提交的 state', () => {
    const stopped: string[] = [];
    const deps = { current: {} as AgentTabActionDeps };

    commit(deps, makeState(stopped, session({ id: 's1' }), undefined));
    const actions = createAgentTabActions(deps);
    const onStop = actions.onStop;

    actions.onStop();
    // 只渲染不提交（会话切换的那一帧被中断/丢弃）：动作仍应作用于屏幕上的 s1
    depsOf(makeState(stopped, session({ id: 's2' }), progress(10)));
    actions.onStop();
    commit(deps, makeState(stopped, session({ id: 's2' }), progress(10)));
    actions.onStop();

    expect(actions.onStop).toBe(onStop);
    expect(stopped).toEqual(['s1', 's1', 's2']);
  });
});
