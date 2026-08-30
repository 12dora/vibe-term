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
