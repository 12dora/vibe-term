import { describe, expect, test } from 'bun:test';

import { ApiClient, type FetchLike } from '@tmex/api-client';
import { noopNotificationSink } from '@tmex/notifications';
import type { AgentSessionDto } from '@tmex/shared';
import {
  activeSessionIdOnNode,
  activeSessionIds,
  agentNodeKey,
  draftOnNode,
  isDraftMaterializingOnNode,
} from './agent-node-state';
import { migrateAgentPersistedState } from './agent-persist';
import { createAgentSessionActions } from './agent-session-actions';
import {
  type AgentGetState,
  type AgentSetState,
  type AgentState,
  createInitialAgentStateData,
} from './agent-state';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

function makeSession(id: string, nodeId: string | null): AgentSessionDto {
  return {
    id,
    title: id,
    nodeId,
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
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface Harness {
  state: () => AgentState;
  subscribed: string[];
  unsubscribed: string[];
  /** 下一次 `GET /api/agent/sessions` 的返回 */
  listed: AgentSessionDto[];
}

function createHarness(initial: Partial<AgentState> = {}): Harness {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const harness: Harness = {
    subscribed,
    unsubscribed,
    listed: [],
    state: () => {
      throw new Error('harness not ready');
    },
  };

  const transport: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/agent/sessions' && method === 'GET') {
      return jsonResponse({ sessions: harness.listed });
    }
    if (url === '/api/agent/sessions' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { nodeId?: string };
      return jsonResponse({ session: makeSession('created', body.nodeId ?? null) });
    }
    if (/^\/api\/agent\/sessions\/[^/]+$/.test(url) && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };

  let state: AgentState;
  const set: AgentSetState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const get: AgentGetState = () => state;

  const actions = createAgentSessionActions({
    apiClient: new ApiClient('', transport),
    notifications: noopNotificationSink,
    set,
    get,
    history: { loadHistory: async () => {}, scheduleFetch: () => {}, clearSession: () => {} },
    subscribe: (sessionId) => subscribed.push(sessionId),
    unsubscribe: (sessionId) => unsubscribed.push(sessionId),
    clearSessionRuntime: () => {},
  });

  state = {
    ...createInitialAgentStateData(),
    ...actions,
    ensureInitialized: () => {},
    ...initial,
  };

  harness.state = () => state;
  return harness;
}

describe('agentNodeKey', () => {
  test('collapses self / null / empty onto one key', () => {
    expect(agentNodeKey(null)).toBe('self');
    expect(agentNodeKey(undefined)).toBe('self');
    expect(agentNodeKey('')).toBe('self');
    expect(agentNodeKey('self')).toBe('self');
    expect(agentNodeKey(NODE_A)).toBe(NODE_A);
  });
});

describe('active session per node', () => {
  test('only reports a session that is really bound to the queried node', () => {
    const remote = makeSession('r1', NODE_A);
    const harness = createHarness({
      sessions: { r1: remote },
      sessionOrder: ['r1'],
      activeSessionIdByNode: { [NODE_A]: 'r1', self: 'r1' },
    });

    expect(activeSessionIdOnNode(harness.state(), NODE_A)).toBe('r1');
    // self 分片里残留的是别的 node 的会话（持久化恢复 / 迁移遗留）：不认
    expect(activeSessionIdOnNode(harness.state(), null)).toBeNull();
  });

  test('a session deleted elsewhere stops being reported', () => {
    const harness = createHarness({ activeSessionIdByNode: { self: 'gone' } });
    expect(activeSessionIdOnNode(harness.state(), null)).toBeNull();
  });

  test('switching to another node keeps the first node selection and subscription', () => {
    const sessionA = makeSession('sa', NODE_A);
    const harness = createHarness({ sessions: { sa: sessionA }, sessionOrder: ['sa'] });

    harness.state().setActiveSession('sa');
    expect(harness.subscribed).toEqual(['sa']);

    // 路由切到 node B 的 pane：B 空态自动起草
    harness
      .state()
      .startDraft({ nodeId: NODE_B, deviceId: 'd2', paneId: '%2', paneTitle: 'pane two' });

    expect(activeSessionIdOnNode(harness.state(), NODE_A)).toBe('sa');
    expect(activeSessionIdOnNode(harness.state(), NODE_B)).toBeNull();
    expect(draftOnNode(harness.state(), NODE_B)?.paneId).toBe('%2');
    expect(draftOnNode(harness.state(), NODE_A)).toBeNull();
    // A 的事件订阅不能被 B 的起草取消
    expect(harness.unsubscribed).toEqual([]);
  });

  test('drafts on different nodes do not overwrite each other', () => {
    const harness = createHarness();
    harness
      .state()
      .startDraft({ nodeId: NODE_A, deviceId: 'd1', paneId: '%1', paneTitle: null, prompt: 'a' });
    harness
      .state()
      .startDraft({ nodeId: NODE_B, deviceId: 'd2', paneId: '%2', paneTitle: null, prompt: 'b' });

    expect(draftOnNode(harness.state(), NODE_A)?.prompt).toBe('a');
    expect(draftOnNode(harness.state(), NODE_B)?.prompt).toBe('b');
  });

  test('selecting a session only clears the draft of its own node', () => {
    const sessionA = makeSession('sa', NODE_A);
    const harness = createHarness({ sessions: { sa: sessionA }, sessionOrder: ['sa'] });
    harness.state().startDraft({ nodeId: NODE_A, deviceId: 'd1', paneId: '%1', paneTitle: null });
    harness.state().startDraft({ nodeId: NODE_B, deviceId: 'd2', paneId: '%2', paneTitle: null });

    harness.state().setActiveSession('sa');

    expect(draftOnNode(harness.state(), NODE_A)).toBeNull();
    expect(draftOnNode(harness.state(), NODE_B)?.paneId).toBe('%2');
  });

  test('materializing a draft on one node leaves the other node input enabled', async () => {
    const harness = createHarness();
    harness.state().startDraft({ nodeId: NODE_A, deviceId: 'd1', paneId: '%1', paneTitle: null });
    harness.state().startDraft({ nodeId: NODE_B, deviceId: 'd2', paneId: '%2', paneTitle: null });

    const pending = harness.state().materializeDraft(NODE_A);
    expect(isDraftMaterializingOnNode(harness.state(), NODE_A)).toBe(true);
    expect(isDraftMaterializingOnNode(harness.state(), NODE_B)).toBe(false);

    await pending;
    expect(activeSessionIdOnNode(harness.state(), NODE_A)).toBe('created');
    expect(draftOnNode(harness.state(), NODE_B)?.paneId).toBe('%2');
  });

  test('deleting a session clears every node holding it and leaves the others alone', async () => {
    const sessionA = makeSession('sa', NODE_A);
    const sessionB = makeSession('sb', NODE_B);
    const harness = createHarness({
      sessions: { sa: sessionA, sb: sessionB },
      sessionOrder: ['sa', 'sb'],
      activeSessionIdByNode: { [NODE_A]: 'sa', [NODE_B]: 'sb' },
    });

    expect(await harness.state().deleteSession('sa')).toBe(true);

    expect(activeSessionIdOnNode(harness.state(), NODE_A)).toBeNull();
    expect(activeSessionIdOnNode(harness.state(), NODE_B)).toBe('sb');
    expect(harness.unsubscribed).toEqual(['sa']);
  });

  test('loadSessions drops selections whose session vanished remotely, per node', async () => {
    const sessionA = makeSession('sa', NODE_A);
    const sessionB = makeSession('sb', NODE_B);
    const harness = createHarness({
      sessions: { sa: sessionA, sb: sessionB },
      sessionOrder: ['sa', 'sb'],
      activeSessionIdByNode: { [NODE_A]: 'sa', [NODE_B]: 'sb' },
    });
    harness.listed = [sessionB];

    await harness.state().loadSessions();

    expect(activeSessionIdOnNode(harness.state(), NODE_A)).toBeNull();
    expect(activeSessionIdOnNode(harness.state(), NODE_B)).toBe('sb');
    expect(harness.unsubscribed).toEqual(['sa']);
  });

  test('activeSessionIds lists every node selection for resubscribe / history catch-up', () => {
    const harness = createHarness({
      activeSessionIdByNode: { self: 's0', [NODE_A]: 'sa', [NODE_B]: null },
    });
    expect(activeSessionIds(harness.state()).sort()).toEqual(['s0', 'sa']);
  });
});

describe('persisted state migration', () => {
  test('moves the v0 single active session onto the self shard', () => {
    const migrated = migrateAgentPersistedState(
      { activeSessionId: 's1', defaultWriteMode: 'auto' },
      0
    );
    expect(migrated.activeSessionIdByNode).toEqual({ self: 's1' });
    expect(migrated.defaultWriteMode).toBe('auto');
  });

  test('keeps an empty shard map when nothing was selected', () => {
    expect(migrateAgentPersistedState({ activeSessionId: null }, 0).activeSessionIdByNode).toEqual(
      {}
    );
    expect(migrateAgentPersistedState(null, 0).activeSessionIdByNode).toEqual({});
  });

  test('passes through anything already on the current version', () => {
    const persisted = { activeSessionIdByNode: { [NODE_A]: 'sa' }, defaultWriteMode: 'confirm' };
    expect(migrateAgentPersistedState(persisted, 1).activeSessionIdByNode).toEqual({
      [NODE_A]: 'sa',
    });
  });
});
