import { describe, expect, test } from 'bun:test';

import { ApiClient, type FetchLike } from '@tmex/api-client';
import { noopNotificationSink } from '@tmex/notifications';
import type { AgentSessionDto } from '@tmex/shared';
import type { AgentHistorySync } from './agent-history-sync';
import { createAgentSessionActions, sortSessionOrder } from './agent-session-actions';
import {
  type AgentGetState,
  type AgentSetState,
  type AgentState,
  createInitialAgentStateData,
} from './agent-state';

function makeSession(id: string, updatedAt: string): AgentSessionDto {
  return {
    id,
    title: id,
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
    updatedAt,
  };
}

function toRecord(sessions: AgentSessionDto[]): Record<string, AgentSessionDto | undefined> {
  const map: Record<string, AgentSessionDto | undefined> = {};
  for (const session of sessions) {
    map[session.id] = session;
  }
  return map;
}

describe('sortSessionOrder', () => {
  test('orders by updatedAt descending', () => {
    const order = sortSessionOrder(
      toRecord([
        makeSession('b', '2026-01-02T00:00:00.000Z'),
        makeSession('a', '2026-01-03T00:00:00.000Z'),
        makeSession('c', '2026-01-01T00:00:00.000Z'),
      ])
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('breaks ties on equal updatedAt by id, independent of insertion order', () => {
    const same = '2026-01-02T00:00:00.000Z';
    const forward = sortSessionOrder(
      toRecord([makeSession('a', same), makeSession('b', same), makeSession('c', same)])
    );
    const reversed = sortSessionOrder(
      toRecord([makeSession('c', same), makeSession('b', same), makeSession('a', same)])
    );

    expect(forward).toEqual(['a', 'b', 'c']);
    expect(reversed).toEqual(['a', 'b', 'c']);
  });

  test('comparator stays antisymmetric for equal timestamps', () => {
    const same = '2026-01-02T00:00:00.000Z';
    const sessions = Array.from({ length: 12 }, (_, index) =>
      makeSession(`s${String(index).padStart(2, '0')}`, same)
    );

    // 洗牌后多次排序必须收敛到同一序列（旧实现在相等时恒返回 -1，结果随插入顺序漂移）
    const shuffled = [...sessions].reverse();
    expect(sortSessionOrder(toRecord(shuffled))).toEqual(sortSessionOrder(toRecord(sessions)));
    expect(sortSessionOrder(toRecord(sessions))).toEqual(sessions.map((session) => session.id));
  });

  test('skips undefined entries', () => {
    const map = toRecord([makeSession('a', '2026-01-02T00:00:00.000Z')]);
    map.gone = undefined;
    expect(sortSessionOrder(map)).toEqual(['a']);
  });
});

interface DraftHarness {
  state: () => AgentState;
  createCount: () => number;
  releaseCreate: () => void;
  subscribed: string[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createDraftHarness(options: { gateCreate?: boolean } = {}): DraftHarness {
  let createCount = 0;
  const createGates: Array<() => void> = [];
  const seqBySession = new Map<string, number>();
  const subscribed: string[] = [];

  const transport: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/agent/sessions' && method === 'POST') {
      createCount += 1;
      const session = makeSession(`s${createCount}`, '2026-01-01T00:00:00.000Z');
      if (options.gateCreate) {
        await new Promise<void>((resolve) => createGates.push(resolve));
      }
      return jsonResponse({ session });
    }
    const sendMatch = /^\/api\/agent\/sessions\/([^/]+)\/messages$/.exec(url);
    if (sendMatch && method === 'POST') {
      const sessionId = sendMatch[1];
      const seq = (seqBySession.get(sessionId) ?? -1) + 1;
      seqBySession.set(sessionId, seq);
      const body = JSON.parse(String(init?.body)) as { text: string };
      return jsonResponse({
        message: {
          id: `${sessionId}-m${seq}`,
          sessionId,
          seq,
          role: 'user',
          content: body.text,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };

  let state: AgentState;
  const set: AgentSetState = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const get: AgentGetState = () => state;

  const history: AgentHistorySync = {
    loadHistory: async () => {},
    scheduleFetch: () => {},
    clearSession: () => {},
  };

  const actions = createAgentSessionActions({
    apiClient: new ApiClient('', transport),
    notifications: noopNotificationSink,
    set,
    get,
    history,
    subscribe: (sessionId) => {
      subscribed.push(sessionId);
    },
    unsubscribe: () => {},
    clearSessionRuntime: () => {},
  });

  state = {
    ...createInitialAgentStateData(),
    ...actions,
    ensureInitialized: () => {},
  };

  return {
    state: () => state,
    createCount: () => createCount,
    releaseCreate: () => {
      const gate = createGates.shift();
      if (!gate) throw new Error('no gated create request');
      gate();
    },
    subscribed,
  };
}

describe('materializeDraft', () => {
  test('concurrent calls share one create request and both messages land in one session', async () => {
    const harness = createDraftHarness();
    harness.state().startDraft('d1', '%1', 'pane one');

    const submit = async (text: string): Promise<void> => {
      const session = await harness.state().materializeDraft();
      expect(session).not.toBeNull();
      if (session) {
        await harness.state().sendMessage(session.id, text);
      }
    };

    const first = submit('first');
    expect(harness.state().materializingDraft).toBe(true);
    const second = submit('second');
    await Promise.all([first, second]);

    expect(harness.createCount()).toBe(1);
    expect(Object.keys(harness.state().sessions)).toEqual(['s1']);
    expect(harness.state().activeSessionId).toBe('s1');
    expect(harness.state().draft).toBeNull();
    expect(harness.state().materializingDraft).toBe(false);
    expect(
      harness
        .state()
        .messages.s1?.map((message) => message.content)
        .sort()
    ).toEqual(['first', 'second']);
  });

  test('repeated calls on the same draft return the identical in-flight promise', () => {
    const harness = createDraftHarness({ gateCreate: true });
    harness.state().startDraft('d1', '%1', null);

    const first = harness.state().materializeDraft();
    const second = harness.state().materializeDraft();
    expect(second).toBe(first);

    harness.releaseCreate();
    return first.then(() => {
      expect(harness.createCount()).toBe(1);
    });
  });

  test('a stale materialization does not take over a newer draft', async () => {
    const harness = createDraftHarness({ gateCreate: true });
    harness.state().startDraft('d1', '%1', 'pane one');
    const pending = harness.state().materializeDraft();

    // 请求在途时用户切到另一个 pane 的新草稿
    harness.state().startDraft('d1', '%2', 'pane two');
    expect(harness.state().materializingDraft).toBe(false);

    harness.releaseCreate();
    const session = await pending;

    expect(session?.id).toBe('s1');
    expect(harness.state().sessions.s1).toBeDefined();
    expect(harness.state().activeSessionId).toBeNull();
    expect(harness.state().draft?.paneId).toBe('%2');
    expect(harness.subscribed).toEqual([]);
  });
});

function createActionsHarness(
  transport: FetchLike,
  initial: Partial<AgentState> = {}
): { state: () => AgentState } {
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

  state = {
    ...createInitialAgentStateData(),
    ...actions,
    ensureInitialized: () => {},
    ...initial,
  };

  return { state: () => state };
}

describe('session metadata updates', () => {
  test('updating a session moves it to the top of sessionOrder', async () => {
    const older = makeSession('a', '2026-01-01T00:00:00.000Z');
    const newer = makeSession('b', '2026-01-02T00:00:00.000Z');
    const transport: FetchLike = (url, init) => {
      if (url === '/api/agent/sessions/a' && init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({
            session: { ...older, writeMode: 'auto', updatedAt: '2026-01-03T00:00:00.000Z' },
          })
        );
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    };
    const harness = createActionsHarness(transport, {
      sessions: { a: older, b: newer },
      sessionOrder: ['b', 'a'],
    });

    await harness.state().setWriteMode('a', 'auto');

    expect(harness.state().sessions.a?.writeMode).toBe('auto');
    expect(harness.state().sessionOrder).toEqual(['a', 'b']);
  });
});

describe('loadSessions', () => {
  test('concurrent calls share a single in-flight request', async () => {
    let fetches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: FetchLike = async (url) => {
      if (url !== '/api/agent/sessions') throw new Error(`unexpected request ${url}`);
      fetches += 1;
      await gate;
      return jsonResponse({ sessions: [makeSession('a', '2026-01-01T00:00:00.000Z')] });
    };
    const harness = createActionsHarness(transport);

    const first = harness.state().loadSessions();
    const second = harness.state().loadSessions();
    expect(second).toBe(first);

    release();
    await Promise.all([first, second]);

    expect(fetches).toBe(1);
    expect(harness.state().sessionsLoaded).toBe(true);
    expect(harness.state().sessionOrder).toEqual(['a']);

    // 结算后槽位释放，后续调用重新发请求
    await harness.state().loadSessions();
    expect(fetches).toBe(2);
  });
});

describe('deleteSession', () => {
  test('sends DELETE, clears the session runtime and drops it from the list', async () => {
    const requests: string[] = [];
    const transport: FetchLike = (url, init) => {
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (url === '/api/agent/sessions/s1' && method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`unexpected request ${method} ${url}`);
    };

    let state: AgentState;
    const set: AgentSetState = (partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    const get: AgentGetState = () => state;

    const clearedRuntimes: string[] = [];
    const actions = createAgentSessionActions({
      apiClient: new ApiClient('', transport),
      notifications: noopNotificationSink,
      set,
      get,
      history: {
        loadHistory: async () => {},
        scheduleFetch: () => {},
        clearSession: () => {},
      },
      subscribe: () => {},
      unsubscribe: () => {},
      clearSessionRuntime: (sessionId) => {
        clearedRuntimes.push(sessionId);
      },
    });

    state = {
      ...createInitialAgentStateData(),
      ...actions,
      ensureInitialized: () => {},
      sessions: { s1: makeSession('s1', '2026-01-01T00:00:00.000Z') },
      sessionOrder: ['s1'],
      activeSessionId: 's1',
    };

    expect(await state.deleteSession('s1')).toBe(true);

    expect(requests).toEqual(['DELETE /api/agent/sessions/s1']);
    expect(clearedRuntimes).toEqual(['s1']);
    expect(state.sessions.s1).toBeUndefined();
    expect(state.sessionOrder).toEqual([]);
    expect(state.activeSessionId).toBeNull();
  });
});
