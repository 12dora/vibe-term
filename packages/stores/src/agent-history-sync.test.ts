import { describe, expect, test } from 'bun:test';

import { ApiClient, type FetchLike } from '@tmex/api-client';
import type { AgentMessageDto } from '@tmex/shared';
import { createAgentHistorySync } from './agent-history-sync';
import { type AgentStateData, createInitialAgentStateData } from './agent-state';

function makeMessage(seq: number, text: string): AgentMessageDto {
  return {
    id: `m${seq}`,
    sessionId: 's1',
    seq,
    role: 'user',
    content: text,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  state: () => AgentStateData;
  patch: (partial: Partial<AgentStateData>) => void;
  requestedUrls: string[];
  respond: (messages: AgentMessageDto[]) => void;
  sync: ReturnType<typeof createAgentHistorySync>;
}

function createHarness(initial: Partial<AgentStateData> = {}): Harness {
  let state: AgentStateData = { ...createInitialAgentStateData(), ...initial };
  const requestedUrls: string[] = [];
  const pendingResponses: Array<(messages: AgentMessageDto[]) => void> = [];

  const transport: FetchLike = (url) => {
    requestedUrls.push(url);
    return new Promise<Response>((resolve) => {
      pendingResponses.push((messages) => resolve(jsonResponse({ messages })));
    });
  };

  const sync = createAgentHistorySync({
    apiClient: new ApiClient('', transport),
    set: (partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    },
    get: () => state,
  });

  return {
    state: () => state,
    patch: (partial) => {
      state = { ...state, ...partial };
    },
    requestedUrls,
    respond: (messages) => {
      const resolve = pendingResponses.shift();
      if (!resolve) throw new Error('no pending history request');
      resolve(messages);
    },
    sync,
  };
}

describe('loadHistory', () => {
  test('keeps a message written to the store while the first request was in flight', async () => {
    const harness = createHarness();

    const pending = harness.sync.loadHistory('s1');
    expect(harness.requestedUrls).toEqual(['/api/agent/sessions/s1/messages']);

    // 发送路径在响应回来之前把新消息写入 store
    harness.patch({ messages: { s1: [makeMessage(1, 'sent while loading')] } });
    // 快照早于该消息生成，不含它
    harness.respond([makeMessage(0, 'older')]);
    await pending;

    expect(harness.state().messages.s1?.map((message) => message.content)).toEqual([
      'older',
      'sent while loading',
    ]);
    expect(harness.state().historyLoaded.s1).toBe(true);
  });

  test('drops a response whose session was cleared while the request was in flight', async () => {
    const harness = createHarness();

    const pending = harness.sync.loadHistory('s1');
    // 会话被删除：deleteSession → clearSessionRuntime → history.clearSession
    harness.sync.clearSession('s1');
    harness.respond([makeMessage(0, 'from deleted session')]);
    await pending;

    expect(harness.state().messages.s1).toBeUndefined();
    expect(harness.state().historyLoaded.s1).toBeUndefined();
    expect(harness.state().inProgress.s1).toBeUndefined();
  });

  test('a request started after clearSession still writes to the store', async () => {
    const harness = createHarness();

    const dropped = harness.sync.loadHistory('s1');
    harness.sync.clearSession('s1');
    harness.respond([makeMessage(0, 'dropped')]);
    await dropped;

    const pending = harness.sync.loadHistory('s1');
    harness.respond([makeMessage(0, 'fresh')]);
    await pending;

    expect(harness.state().messages.s1?.map((message) => message.content)).toEqual(['fresh']);
    expect(harness.state().historyLoaded.s1).toBe(true);
  });

  test('re-runs a reload requested while the first request was in flight', async () => {
    const harness = createHarness();

    const first = harness.sync.loadHistory('s1');
    // in-flight 期间的第二次请求只登记补跑
    const deduped = harness.sync.loadHistory('s1');
    expect(harness.requestedUrls).toEqual(['/api/agent/sessions/s1/messages']);

    harness.respond([makeMessage(0, 'older')]);
    await Promise.all([first, deduped]);

    // 补跑在第一次响应的 finally 中发起，且按已写入的 seq 增量拉取
    expect(harness.requestedUrls).toEqual([
      '/api/agent/sessions/s1/messages',
      '/api/agent/sessions/s1/messages?afterSeq=0',
    ]);
    harness.respond([makeMessage(1, 'newer')]);
    await flushMicrotasks();

    expect(harness.state().messages.s1?.map((message) => message.content)).toEqual([
      'older',
      'newer',
    ]);
  });

  test('incremental reload asks for afterSeq and merges onto existing messages', async () => {
    const harness = createHarness({
      messages: { s1: [makeMessage(0, 'older')] },
      historyLoaded: { s1: true },
    });

    const pending = harness.sync.loadHistory('s1');
    expect(harness.requestedUrls).toEqual(['/api/agent/sessions/s1/messages?afterSeq=0']);
    harness.respond([makeMessage(1, 'newer')]);
    await pending;

    expect(harness.state().messages.s1?.map((message) => message.content)).toEqual([
      'older',
      'newer',
    ]);
  });
});
