// 非活跃会话历史的保留预算：打开大量会话后内存不应随打开次数线性增长。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ApiClient, type FetchLike } from '@tmex/api-client';
import { noopNotificationSink } from '@tmex/notifications';
import type { AgentMessageDto, AgentSessionDto } from '@tmex/shared';

import { createAgentStore } from './agent';
import {
  HISTORY_SESSION_BUDGET,
  HISTORY_SIZE_BUDGET,
  selectEvictableHistories,
} from './agent-history-budget';
import { type AgentStateData, createInitialAgentStateData } from './agent-state';
import type { RuntimeCore } from './runtime';
import { installWindowStorage } from './test-utils';

const SESSION_COUNT = 200;
const HISTORY_TEXT = 'x'.repeat(1024);

function makeSession(id: string, index: number): AgentSessionDto {
  return {
    id,
    title: id,
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
    updatedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
  };
}

function makeMessage(sessionId: string, text = HISTORY_TEXT): AgentMessageDto {
  return {
    id: `${sessionId}-m0`,
    sessionId,
    seq: 0,
    role: 'assistant',
    content: { text },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

interface StoreHarness {
  store: ReturnType<typeof createAgentStore>;
  messageUrls: string[];
  setRemote: (sessions: AgentSessionDto[]) => void;
  /** deferHistory 模式下放行所有挂起的历史响应 */
  releaseHistory: () => Promise<void>;
}

function createStoreHarness(
  sessions: AgentSessionDto[],
  options: { deferHistory?: boolean } = {}
): StoreHarness {
  let remote = sessions;
  const messageUrls: string[] = [];
  const heldHistory: Array<() => void> = [];

  const transport: FetchLike = async (url) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/api/agent/sessions') return json({ sessions: remote });
    const match = /^\/api\/agent\/sessions\/([^/?]+)\/messages/.exec(url);
    if (match) {
      messageUrls.push(url);
      if (options.deferHistory) {
        await new Promise<void>((resolve) => heldHistory.push(resolve));
      }
      return json({ messages: [makeMessage(match[1])] });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const core = {
    client: { send: () => {}, connect: () => {}, onMessage: () => () => {} },
    apiClient: new ApiClient('', transport),
    notifications: noopNotificationSink,
    t: (key: string) => key,
    storagePrefix: `history-budget-${Math.random()}-`,
  } as unknown as RuntimeCore;

  return {
    store: createAgentStore(core),
    messageUrls,
    setRemote: (next) => {
      remote = next;
    },
    releaseHistory: async () => {
      while (heldHistory.length > 0) {
        for (const resolve of heldHistory.splice(0)) resolve();
        await flush();
      }
    },
  };
}

/** 放行在途的历史请求：loadHistory 由 setActiveSession 异步触发，不返回句柄 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let restoreGlobals: (() => void) | null = null;

beforeEach(() => {
  restoreGlobals = installWindowStorage();
});

afterEach(() => {
  restoreGlobals?.();
  restoreGlobals = null;
});

describe('非活跃历史的保留预算（真实 store）', () => {
  test('依次打开 200 个会话后，保留的历史数组不超过预算', async () => {
    const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => makeSession(`s${i}`, i));
    const harness = createStoreHarness(sessions);
    await harness.store.getState().loadSessions();

    for (const session of sessions) {
      harness.store.getState().setActiveSession(session.id);
      await flush();
    }

    const state = harness.store.getState();
    const retained = Object.keys(state.messages);
    // 预算之外还多留一份：最后激活的会话本身固定保留
    expect(retained.length).toBeLessThanOrEqual(HISTORY_SESSION_BUDGET + 1);
    expect(retained).toContain(`s${SESSION_COUNT - 1}`);
    // 侧栏读的是会话元数据，不受历史淘汰影响
    expect(Object.keys(state.sessions).length).toBe(SESSION_COUNT);
    expect(state.sessionOrder.length).toBe(SESSION_COUNT);
    for (const sessionId of retained) {
      expect(state.historyLoaded[sessionId]).toBe(true);
    }
  });

  test('首次历史响应集中延迟返回时，写回后仍不超预算', async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => makeSession(`s${i}`, i));
    const harness = createStoreHarness(sessions, { deferHistory: true });
    await harness.store.getState().loadSessions();

    // 一份历史都不放行就把 20 个会话全部激活：淘汰不能只发生在切换会话时
    for (const session of sessions) {
      harness.store.getState().setActiveSession(session.id);
    }
    await flush();
    await harness.releaseHistory();

    const state = harness.store.getState();
    const retained = Object.keys(state.messages);
    expect(retained.length).toBeLessThanOrEqual(HISTORY_SESSION_BUDGET + 1);
    expect(retained).toContain('s19');
    expect(Object.keys(state.sessions).length).toBe(20);
  });

  test('被淘汰的会话重新打开时全量重拉一次历史', async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => makeSession(`s${i}`, i));
    const harness = createStoreHarness(sessions);
    await harness.store.getState().loadSessions();

    for (const session of sessions) {
      harness.store.getState().setActiveSession(session.id);
      await flush();
    }

    expect(harness.store.getState().messages.s0).toBeUndefined();
    expect(harness.store.getState().historyLoaded.s0).toBeUndefined();
    const before = harness.messageUrls.filter((url) => url.includes('/s0/messages')).length;
    expect(before).toBe(1);

    harness.store.getState().setActiveSession('s0');
    await flush();

    const s0Urls = harness.messageUrls.filter((url) => url.includes('/s0/messages'));
    expect(s0Urls.length).toBe(2);
    // 历史已清空，重拉必须是全量（不带 afterSeq），否则只会补回半截
    expect(s0Urls[1]).not.toContain('afterSeq');
    expect(harness.store.getState().messages.s0?.length).toBe(1);
  });

  test('列表刷新为空后不残留任何会话态', async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => makeSession(`s${i}`, i));
    const harness = createStoreHarness(sessions);
    await harness.store.getState().loadSessions();

    for (const session of sessions) {
      harness.store.getState().setActiveSession(session.id);
      await flush();
    }
    harness.store.setState({
      inProgress: { s19: { texts: [], reasonings: [], toolCalls: [], staleBarrier: false } },
      queued: { s19: [{ id: 'q1', sessionId: 's19', seq: 1, text: 'hi', createdAt: '' }] },
    });

    harness.setRemote([]);
    await harness.store.getState().loadSessions();

    const state = harness.store.getState();
    expect(Object.keys(state.sessions)).toEqual([]);
    expect(Object.keys(state.messages)).toEqual([]);
    expect(Object.keys(state.historyLoaded)).toEqual([]);
    expect(Object.keys(state.inProgress)).toEqual([]);
    expect(Object.keys(state.queued)).toEqual([]);
    expect(Object.keys(state.pendingConfirmations)).toEqual([]);
    expect(state.activeSessionIdByNode.self).toBeNull();
  });
});

function stateWith(
  ids: readonly string[],
  patch: Partial<AgentStateData> = {},
  text = HISTORY_TEXT
): AgentStateData {
  const base = createInitialAgentStateData();
  for (const [index, id] of ids.entries()) {
    base.sessions[id] = makeSession(id, index);
    base.messages[id] = [makeMessage(id, text)];
    base.historyLoaded[id] = true;
  }
  return { ...base, ...patch };
}

describe('selectEvictableHistories', () => {
  test('当前会话与忙碌会话不被淘汰', () => {
    const ids = Array.from({ length: HISTORY_SESSION_BUDGET + 4 }, (_, i) => `s${i}`);
    const state = stateWith(ids, {
      activeSessionIdByNode: { self: 's0', 'node:a': 's1' },
      queued: { s2: [{ id: 'q1', sessionId: 's2', seq: 1, text: 'hi', createdAt: '' }] },
    });
    state.sessions.s3 = { ...makeSession('s3', 3), status: 'running' };

    const evicted = selectEvictableHistories(state, []);

    expect(evicted).not.toContain('s0');
    expect(evicted).not.toContain('s1');
    expect(evicted).not.toContain('s2');
    expect(evicted).not.toContain('s3');
    expect(evicted.length).toBe(ids.length - 4 - HISTORY_SESSION_BUDGET);
  });

  test('按最近激活顺序保留，最久未激活的先淘汰', () => {
    const ids = Array.from({ length: HISTORY_SESSION_BUDGET + 2 }, (_, i) => `s${i}`);
    const recent = [...ids].reverse();

    const evicted = selectEvictableHistories(stateWith(ids), recent);

    expect(evicted.sort()).toEqual(['s0', 's1']);
  });

  test('体积预算先于份数预算触发', () => {
    const ids = ['s0', 's1', 's2'];
    const huge = 'x'.repeat(HISTORY_SIZE_BUDGET / 2 + 1);

    const evicted = selectEvictableHistories(stateWith(ids, {}, huge), ids);

    // 两份就已超出体积预算，份数远未到上限也要淘汰
    expect(evicted).toEqual(['s1', 's2']);
  });
});
