import { describe, expect, test } from 'bun:test';

import { ApiClient, type FetchLike } from '@tmex/api-client';
import { noopNotificationSink } from '@tmex/notifications';
import type { AgentSessionDto } from '@tmex/shared';
import { draftOnNode } from './agent-node-state';
import { createAgentSessionActions } from './agent-session-actions';
import { isSessionOnNode, normalizeAgentNodeId } from './agent-session-map';
import {
  type AgentGetState,
  type AgentSetState,
  type AgentState,
  createInitialAgentStateData,
} from './agent-state';

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

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

describe('normalizeAgentNodeId', () => {
  test('collapses self / empty values to null', () => {
    expect(normalizeAgentNodeId(undefined)).toBeNull();
    expect(normalizeAgentNodeId(null)).toBeNull();
    expect(normalizeAgentNodeId('')).toBeNull();
    expect(normalizeAgentNodeId('self')).toBeNull();
    expect(normalizeAgentNodeId(NODE_A)).toBe(NODE_A);
  });
});

describe('isSessionOnNode', () => {
  test('matches self sessions against self / null / undefined route ids', () => {
    const session = makeSession('s1', null);
    expect(isSessionOnNode(session, null)).toBe(true);
    expect(isSessionOnNode(session, 'self')).toBe(true);
    expect(isSessionOnNode(session, NODE_A)).toBe(false);
  });

  test('matches remote sessions only against their own node', () => {
    const session = makeSession('s1', NODE_A);
    expect(isSessionOnNode(session, NODE_A)).toBe(true);
    expect(isSessionOnNode(session, NODE_B)).toBe(false);
    expect(isSessionOnNode(session, null)).toBe(false);
  });
});

describe('filtering a shared session list by node', () => {
  const local = makeSession('local', null);
  const remoteA = makeSession('remoteA', NODE_A);
  const remoteB = makeSession('remoteB', NODE_B);
  const all = [remoteB, local, remoteA];

  test('keeps only the sessions bound to the given node, in list order', () => {
    expect(all.filter((s) => isSessionOnNode(s, null))).toEqual([local]);
    expect(all.filter((s) => isSessionOnNode(s, 'self'))).toEqual([local]);
    expect(all.filter((s) => isSessionOnNode(s, NODE_A))).toEqual([remoteA]);
    expect(all.filter((s) => isSessionOnNode(s, NODE_B))).toEqual([remoteB]);
  });
});

interface CreateHarness {
  state: () => AgentState;
  bodies: () => Array<Record<string, unknown>>;
}

function createHarness(): CreateHarness {
  const bodies: Array<Record<string, unknown>> = [];
  const transport: FetchLike = async (url, init) => {
    if (url === '/api/agent/sessions' && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return new Response(
        JSON.stringify({
          session: makeSession('created', (body.nodeId as string | null | undefined) ?? null),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
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
    subscribe: () => {},
    unsubscribe: () => {},
    clearSessionRuntime: () => {},
  });

  state = { ...createInitialAgentStateData(), ...actions, ensureInitialized: () => {} };
  return { state: () => state, bodies: () => bodies };
}

describe('createSession carries the bound node', () => {
  test('omits nodeId for self sessions', async () => {
    const harness = createHarness();
    await harness.state().createSession('d1', '%1', { nodeId: null });
    expect(harness.bodies()[0]).not.toHaveProperty('nodeId');
  });

  test('sends the remote nodeId when the draft is bound to another node', async () => {
    const harness = createHarness();
    harness.state().startDraft({ nodeId: NODE_A, deviceId: 'd1', paneId: '%1', paneTitle: 'vim' });
    expect(draftOnNode(harness.state(), NODE_A)?.nodeId).toBe(NODE_A);

    const session = await harness.state().materializeDraft(NODE_A);

    expect(harness.bodies()[0]?.nodeId).toBe(NODE_A);
    expect(session?.nodeId).toBe(NODE_A);
  });
});
