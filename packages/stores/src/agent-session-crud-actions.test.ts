import { describe, expect, test } from 'bun:test';

import { ApiClient, type FetchLike } from '@tmex/api-client';
import { noopNotificationSink } from '@tmex/notifications';
import type { AgentSessionDto } from '@tmex/shared';
import { createAgentSessionActions } from './agent-session-actions';
import { mergeFetchedSessions } from './agent-session-map';
import {
  type AgentGetState,
  type AgentSetState,
  type AgentState,
  createInitialAgentStateData,
} from './agent-state';

function makeSession(id: string, updatedAt: string, title = id): AgentSessionDto {
  return {
    id,
    title,
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
    updatedAt,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface LoadHarness {
  state: () => AgentState;
  set: AgentSetState;
  /** 放行 in-flight 的列表请求，令其返回 sessions */
  releaseLoad: (sessions: AgentSessionDto[]) => void;
  clearedRuntimes: string[];
}

/** 列表请求可门控的 harness：用于复现「拉取在途时发生本地写入」 */
function createLoadHarness(initial: Partial<AgentState> = {}): LoadHarness {
  let releaseLoad: (sessions: AgentSessionDto[]) => void = () => {};
  const loadGate = new Promise<AgentSessionDto[]>((resolve) => {
    releaseLoad = resolve;
  });
  let created = 0;

  const transport: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/agent/sessions' && method === 'GET') {
      return jsonResponse({ sessions: await loadGate });
    }
    if (url === '/api/agent/sessions' && method === 'POST') {
      created += 1;
      return jsonResponse({ session: makeSession(`new${created}`, '2026-02-01T00:00:00.000Z') });
    }
    const patchMatch = /^\/api\/agent\/sessions\/([^/]+)$/.exec(url);
    if (patchMatch && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { title?: string };
      return jsonResponse({
        session: makeSession(patchMatch[1], '2026-03-01T00:00:00.000Z', body.title ?? 'renamed'),
      });
    }
    if (patchMatch && method === 'DELETE') {
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

  const clearedRuntimes: string[] = [];
  const actions = createAgentSessionActions({
    apiClient: new ApiClient('', transport),
    notifications: noopNotificationSink,
    set,
    get,
    history: { loadHistory: async () => {}, scheduleFetch: () => {}, clearSession: () => {} },
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
    ...initial,
  };

  return { state: () => state, set, releaseLoad, clearedRuntimes };
}

describe('mergeFetchedSessions', () => {
  test('adds remotely created sessions and drops remotely deleted ones', () => {
    const a = makeSession('a', '2026-01-01T00:00:00.000Z');
    const b = makeSession('b', '2026-01-02T00:00:00.000Z');
    const c = makeSession('c', '2026-01-03T00:00:00.000Z');

    const merged = mergeFetchedSessions({ a, b }, { a, b }, [a, c]);

    expect(Object.keys(merged).sort()).toEqual(['a', 'c']);
  });

  test('keeps the local entry when it was rewritten while the request was in flight', () => {
    const a = makeSession('a', '2026-01-01T00:00:00.000Z');
    const local = { ...a, status: 'running' as const };

    const merged = mergeFetchedSessions({ a }, { a: local }, [a]);

    expect(merged.a).toBe(local);
  });

  test('does not resurrect a session deleted while the request was in flight', () => {
    const a = makeSession('a', '2026-01-01T00:00:00.000Z');

    expect(mergeFetchedSessions({ a }, {}, [a])).toEqual({});
  });

  test('ignores undefined placeholders in the current map', () => {
    const a = makeSession('a', '2026-01-01T00:00:00.000Z');

    const merged = mergeFetchedSessions({}, { a, gone: undefined }, []);

    expect(Object.keys(merged)).toEqual(['a']);
  });
});

describe('loadSessions concurrency', () => {
  test('keeps a session created while the list request is in flight', async () => {
    const existing = makeSession('a', '2026-01-01T00:00:00.000Z');
    const harness = createLoadHarness({ sessions: { a: existing }, sessionOrder: ['a'] });

    const loading = harness.state().loadSessions();
    const created = await harness.state().createSession('d1', '%9');
    expect(created?.id).toBe('new1');

    harness.releaseLoad([existing]);
    await loading;

    expect(Object.keys(harness.state().sessions).sort()).toEqual(['a', 'new1']);
    expect(harness.state().sessionOrder).toEqual(['new1', 'a']);
    expect(harness.state().activeSessionId).toBe('new1');
  });

  test('keeps a rename that landed while the list request is in flight', async () => {
    const stale = makeSession('a', '2026-01-01T00:00:00.000Z', 'old');
    const harness = createLoadHarness({ sessions: { a: stale }, sessionOrder: ['a'] });

    const loading = harness.state().loadSessions();
    expect(await harness.state().renameSession('a', 'fresh')).toBe(true);

    harness.releaseLoad([stale]);
    await loading;

    expect(harness.state().sessions.a?.title).toBe('fresh');
    expect(harness.state().sessions.a?.updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  test('does not resurrect a session deleted while the list request is in flight', async () => {
    const doomed = makeSession('a', '2026-01-01T00:00:00.000Z');
    const other = makeSession('b', '2026-01-02T00:00:00.000Z');
    const harness = createLoadHarness({
      sessions: { a: doomed, b: other },
      sessionOrder: ['b', 'a'],
      activeSessionId: 'a',
    });

    const loading = harness.state().loadSessions();
    expect(await harness.state().deleteSession('a')).toBe(true);

    harness.releaseLoad([doomed, other]);
    await loading;

    expect(harness.state().sessions.a).toBeUndefined();
    expect(harness.state().sessionOrder).toEqual(['b']);
    expect(harness.state().activeSessionId).toBeNull();
    expect(harness.clearedRuntimes).toEqual(['a']);
  });

  test('keeps a WS status update that landed while the list request is in flight', async () => {
    const idle = makeSession('a', '2026-01-01T00:00:00.000Z');
    const harness = createLoadHarness({ sessions: { a: idle }, sessionOrder: ['a'] });

    const loading = harness.state().loadSessions();
    // 模拟 AGENT_EVENT_STATUS 的写法：原地替换该会话条目
    harness.set((prev) => {
      const session = prev.sessions.a;
      if (!session) return prev;
      return { sessions: { ...prev.sessions, a: { ...session, status: 'running' } } };
    });

    harness.releaseLoad([idle]);
    await loading;

    expect(harness.state().sessions.a?.status).toBe('running');
  });

  test('still applies remote deletions for sessions untouched locally', async () => {
    const kept = makeSession('a', '2026-01-01T00:00:00.000Z');
    const removed = makeSession('b', '2026-01-02T00:00:00.000Z');
    const harness = createLoadHarness({
      sessions: { a: kept, b: removed },
      sessionOrder: ['b', 'a'],
      activeSessionId: 'b',
    });

    const loading = harness.state().loadSessions();
    harness.releaseLoad([kept]);
    await loading;

    expect(harness.state().sessions.b).toBeUndefined();
    expect(harness.state().sessionOrder).toEqual(['a']);
    expect(harness.state().activeSessionId).toBeNull();
    expect(harness.state().sessionsLoaded).toBe(true);
  });
});
