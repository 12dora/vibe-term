// 分屏 pane 的 agent 徽标选择器：会话表是全 mesh 一份，必须按 nodeId 过滤。

import { describe, expect, test } from 'bun:test';

import type { AgentSessionDto } from '@tmex/shared';
import { type AgentState, createInitialAgentStateData } from './agent-state';
import { selectPaneAgentState } from './use-pane-agent-state';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

function session(partial: Partial<AgentSessionDto> & { id: string }): AgentSessionDto {
  return {
    title: partial.id,
    nodeId: null,
    deviceId: 'd1',
    paneId: '%1',
    providerId: null,
    modelId: 'model',
    systemPrompt: null,
    writeMode: 'confirm',
    useProviderWebSearch: false,
    providerHostedTools: [],
    allowControlChars: false,
    originPaneTitle: null,
    originProcessName: null,
    status: 'idle',
    lastError: null,
    maxStepsPerTurn: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function stateWith(...sessions: AgentSessionDto[]): AgentState {
  const data = createInitialAgentStateData();
  for (const item of sessions) data.sessions[item.id] = item;
  data.sessionOrder = sessions.map((item) => item.id);
  return data as AgentState;
}

describe('selectPaneAgentState', () => {
  test('无绑定会话时为 none', () => {
    expect(selectPaneAgentState(stateWith(), 'd1', '%1', null)).toBe('none');
  });

  test('idle / waiting_confirmation 为 bound，running 为 generating', () => {
    expect(selectPaneAgentState(stateWith(session({ id: 's' })), 'd1', '%1', null)).toBe('bound');
    expect(
      selectPaneAgentState(
        stateWith(session({ id: 's', status: 'waiting_confirmation' })),
        'd1',
        '%1',
        null
      )
    ).toBe('bound');
    expect(
      selectPaneAgentState(stateWith(session({ id: 's', status: 'running' })), 'd1', '%1', null)
    ).toBe('generating');
  });

  test('stopped / error 的会话不点亮徽标', () => {
    expect(
      selectPaneAgentState(stateWith(session({ id: 's', status: 'stopped' })), 'd1', '%1', null)
    ).toBe('none');
    expect(
      selectPaneAgentState(stateWith(session({ id: 's', status: 'error' })), 'd1', '%1', null)
    ).toBe('none');
  });

  test('只认本 node 的会话：不同 node 上同名 device:pane 不串台', () => {
    const state = stateWith(
      session({ id: 'local' }),
      session({ id: 'remote', nodeId: NODE_A, status: 'running' })
    );
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('bound');
    expect(selectPaneAgentState(state, 'd1', '%1', NODE_A)).toBe('generating');
    expect(selectPaneAgentState(state, 'd1', '%1', NODE_B)).toBe('none');
  });

  test('self 与 null 等价', () => {
    const state = stateWith(session({ id: 'local', nodeId: 'self' }));
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('bound');
    expect(selectPaneAgentState(state, 'd1', '%1', 'self')).toBe('bound');
  });

  test('device / pane 不匹配时为 none', () => {
    const state = stateWith(session({ id: 'local' }));
    expect(selectPaneAgentState(state, 'd2', '%1', null)).toBe('none');
    expect(selectPaneAgentState(state, 'd1', '%2', null)).toBe('none');
  });
});

describe('selectPaneAgentState 多会话聚合', () => {
  test('同一 pane 上 idle 在前、running 在后也报 generating', () => {
    const state = stateWith(session({ id: 'idle' }), session({ id: 'running', status: 'running' }));
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('generating');
  });

  test('running 在前、idle 在后同样报 generating', () => {
    const state = stateWith(session({ id: 'running', status: 'running' }), session({ id: 'idle' }));
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('generating');
  });

  test('running 会话属于别的 node 时不点亮本 node 的 generating', () => {
    const state = stateWith(
      session({ id: 'idle' }),
      session({ id: 'remote', nodeId: NODE_A, status: 'running' })
    );
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('bound');
    expect(selectPaneAgentState(state, 'd1', '%1', NODE_A)).toBe('generating');
  });

  test('running 已结束（stopped）后回落到 bound', () => {
    const state = stateWith(session({ id: 'stopped', status: 'stopped' }), session({ id: 'idle' }));
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('bound');
  });

  test('未绑定 pane 的会话不参与索引', () => {
    const state = stateWith(session({ id: 'unbound', deviceId: '', paneId: '' }));
    expect(selectPaneAgentState(state, '', '', null)).toBe('none');
  });
});

describe('selectPaneAgentState 索引缓存', () => {
  test('sessions 引用更新后结果随之更新', () => {
    const before = stateWith(session({ id: 's' }));
    expect(selectPaneAgentState(before, 'd1', '%1', null)).toBe('bound');
    const after: AgentState = {
      ...before,
      sessions: { ...before.sessions, s: session({ id: 's', status: 'running' }) },
    };
    expect(selectPaneAgentState(after, 'd1', '%1', null)).toBe('generating');
    // 旧引用仍给出旧结果，说明缓存按 sessions 引用分桶而非全局单例
    expect(selectPaneAgentState(before, 'd1', '%1', null)).toBe('bound');
  });

  test('同一 sessions 引用重复查询结果稳定', () => {
    const state = stateWith(session({ id: 's', status: 'running' }));
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('generating');
    expect(selectPaneAgentState(state, 'd1', '%1', null)).toBe('generating');
    expect(selectPaneAgentState(state, 'd1', '%2', null)).toBe('none');
  });
});
