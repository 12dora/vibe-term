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
