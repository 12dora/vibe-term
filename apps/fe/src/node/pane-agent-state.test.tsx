// 分屏 pane 的 agent 徽标接线：会话由 entry 网关统一持有，`/n/:nodeId` 路由下的 pane
// 也必须读那一份 store（`setAgentHostStore` 注册的解析器），并按本 runtime 的 nodeId 过滤。
// 无 DOM 测试环境，用 react-dom/server 静态渲染。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentSessionDto } from '@tmex/shared';
import type { AgentState, AgentStore, AppRuntime } from '@tmex/stores';
import { setAgentHostStore } from '@tmex/stores';
import { RuntimeProvider, usePaneAgentState } from '@tmex/stores/react';

const { renderToStaticMarkup } = await import('react-dom/server');

const NODE_A = 'a'.repeat(32);

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

function storeWith(...sessions: AgentSessionDto[]): AgentStore {
  const state = {
    sessions: Object.fromEntries(sessions.map((item) => [item.id, item])),
  } as unknown as AgentState;
  return (<T,>(selector: (value: AgentState) => T) => selector(state)) as unknown as AgentStore;
}

function runtimeWith(nodeId: string, agent: AgentStore): AppRuntime {
  return { nodeId, stores: { agent } } as unknown as AppRuntime;
}

function renderBadge(runtime: AppRuntime): string {
  function Probe() {
    return <span data-state={usePaneAgentState('d1', '%1')} />;
  }
  return renderToStaticMarkup(
    <RuntimeProvider runtime={runtime}>
      <Probe />
    </RuntimeProvider>
  );
}

afterEach(() => {
  setAgentHostStore(null);
});

describe('usePaneAgentState', () => {
  test('远端路由下读宿主 store，并只认本 node 的会话', () => {
    setAgentHostStore(() =>
      storeWith(session({ id: 'local' }), session({ id: 'remote', nodeId: NODE_A }))
    );
    // 路由 runtime 自己的 store 是空的：徽标亮起来就说明读的是宿主那份
    expect(renderBadge(runtimeWith(NODE_A, storeWith()))).toContain('data-state="bound"');
  });

  test('别的 node 上同名 device:pane 不点亮本 node 的徽标', () => {
    setAgentHostStore(() => storeWith(session({ id: 'remote', nodeId: NODE_A })));
    expect(renderBadge(runtimeWith('self', storeWith()))).toContain('data-state="none"');
  });

  test('会话流式输出时为 generating', () => {
    setAgentHostStore(() =>
      storeWith(session({ id: 'remote', nodeId: NODE_A, status: 'running' }))
    );
    expect(renderBadge(runtimeWith(NODE_A, storeWith()))).toContain('data-state="generating"');
  });

  test('未注册解析器（standalone）时回落到路由 runtime 自己的 store', () => {
    expect(renderBadge(runtimeWith('self', storeWith(session({ id: 'local' }))))).toContain(
      'data-state="bound"'
    );
  });
});
