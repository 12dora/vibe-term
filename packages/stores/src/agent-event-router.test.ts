import { describe, expect, test } from 'bun:test';

import type { NotificationSink } from '@tmex/notifications';
import type { AgentSessionDto } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { createAgentDeltaBuffer } from './agent-delta-buffer';
import { type AgentEventContext, dispatchAgentEvent } from './agent-event-router';
import type { AgentHistorySync } from './agent-history-sync';
import { type AgentStateData, createInitialAgentStateData } from './agent-state';

interface NotificationCall {
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: unknown;
}

interface Harness {
  ctx: AgentEventContext;
  state: () => AgentStateData;
  notifications: NotificationCall[];
  historyCalls: string[];
  refreshed: string[];
  loadSessionsCalls: number;
  flushDeltas: () => void;
}

function makeSession(overrides: Partial<AgentSessionDto> = {}): AgentSessionDto {
  return {
    id: 's1',
    title: 'session',
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
    ...overrides,
  };
}

function createHarness(initial: Partial<AgentStateData> = {}): Harness {
  let state: AgentStateData = { ...createInitialAgentStateData(), ...initial };
  const notifications: NotificationCall[] = [];
  const historyCalls: string[] = [];
  const refreshed: string[] = [];
  const harness = { loadSessionsCalls: 0 };

  const set: AgentEventContext['set'] = (partial) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };

  const record =
    (level: NotificationCall['level']) => (title: string, options?: { description?: unknown }) => {
      notifications.push({ level, title, description: options?.description });
    };

  const sink: NotificationSink = {
    info: record('info'),
    success: record('success'),
    warning: record('warning'),
    error: record('error'),
  };

  // flushMs 很大：测试自行调用 flush，验证 delta 先入缓冲再落状态
  const deltas = createAgentDeltaBuffer(set, 10_000);

  const history: AgentHistorySync = {
    loadHistory: async (sessionId) => {
      historyCalls.push(`load:${sessionId}`);
    },
    scheduleFetch: (sessionId) => {
      historyCalls.push(`schedule:${sessionId}`);
    },
    clearSession: (sessionId) => {
      historyCalls.push(`clear:${sessionId}`);
    },
  };

  const ctx: AgentEventContext = {
    set,
    get: () => state,
    notifications: sink,
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    deltas,
    history,
    loadSessions: () => {
      harness.loadSessionsCalls += 1;
    },
    refreshSession: (sessionId) => {
      refreshed.push(sessionId);
    },
  };

  return {
    ctx,
    state: () => state,
    notifications,
    historyCalls,
    refreshed,
    get loadSessionsCalls() {
      return harness.loadSessionsCalls;
    },
    flushDeltas: () => deltas.flush(),
  };
}

describe('dispatchAgentEvent', () => {
  test('text delta accumulates in the throttle buffer and lands on flush', () => {
    const h = createHarness();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TEXT_DELTA, 's1', {
      messageId: 'm1',
      delta: 'Hel',
    });
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TEXT_DELTA, 's1', {
      messageId: 'm1',
      delta: 'lo',
    });
    expect(h.state().inProgress.s1).toBeUndefined();

    h.flushDeltas();
    expect(h.state().inProgress.s1?.texts).toEqual([
      { messageId: 'm1', text: 'Hello', stale: false },
    ]);
  });

  test('reasoning delta lands on the reasonings channel', () => {
    const h = createHarness();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_REASONING_DELTA, 's1', {
      messageId: 'r1',
      delta: 'think',
    });
    h.flushDeltas();

    expect(h.state().inProgress.s1?.reasonings).toEqual([
      { messageId: 'r1', text: 'think', stale: false },
    ]);
    expect(h.state().inProgress.s1?.texts).toEqual([]);
  });

  test('tool call flushes buffered deltas and appends an unresolved call', () => {
    const h = createHarness();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TEXT_DELTA, 's1', {
      messageId: 'm1',
      delta: 'before tool',
    });
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TOOL_CALL, 's1', {
      toolCallId: 't1',
      toolName: 'send_input',
      input: { keys: 'ls' },
    });

    const inProgress = h.state().inProgress.s1;
    expect(inProgress?.texts).toEqual([{ messageId: 'm1', text: 'before tool', stale: false }]);
    expect(inProgress?.toolCalls).toEqual([
      {
        toolCallId: 't1',
        toolName: 'send_input',
        input: { keys: 'ls' },
        isError: false,
        denied: false,
        resolved: false,
        stale: false,
      },
    ]);
  });

  test('tool result resolves the matching call and unwraps the output', () => {
    const h = createHarness();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TOOL_CALL, 's1', {
      toolCallId: 't1',
      toolName: 'read_file',
      input: { path: '/tmp/a' },
    });
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TOOL_RESULT, 's1', {
      toolCallId: 't1',
      toolName: 'read_file',
      output: { type: 'error-text', value: 'boom' },
    });

    expect(h.state().inProgress.s1?.toolCalls).toEqual([
      {
        toolCallId: 't1',
        toolName: 'read_file',
        input: { path: '/tmp/a' },
        output: 'boom',
        isError: true,
        denied: false,
        resolved: true,
        stale: false,
      },
    ]);
  });

  test('error event raises a notification and leaves state untouched', () => {
    const h = createHarness({ sessions: { s1: makeSession({ title: 'my agent' }) } });
    const before = h.state();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_ERROR, 's1', { message: 'model exploded' });

    expect(h.notifications).toEqual([
      {
        level: 'error',
        title: 'agent.toast.errorTitle:{"title":"my agent"}',
        description: 'model exploded',
      },
    ]);
    expect(h.state()).toBe(before);
  });

  test('turn finished clears inProgress, applies status and pulls missing history', () => {
    const h = createHarness({ sessions: { s1: makeSession({ status: 'running' }) } });

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TEXT_DELTA, 's1', {
      messageId: 'm1',
      delta: 'streamed',
    });
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TURN_FINISHED, 's1', {
      sessionStatus: 'idle',
      lastMessageSeq: 4,
    });

    expect(h.state().sessions.s1?.status).toBe('idle');
    expect(h.state().inProgress.s1).toEqual({
      texts: [],
      reasonings: [],
      toolCalls: [],
      staleBarrier: false,
    });
    expect(h.historyCalls).toEqual(['schedule:s1']);
  });

  test('turn finished skips the history fetch when local messages are already current', () => {
    const h = createHarness({
      sessions: { s1: makeSession() },
      messages: {
        s1: [{ id: 'm1', sessionId: 's1', seq: 7, role: 'assistant', content: {}, createdAt: '' }],
      },
    });

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TURN_FINISHED, 's1', {
      sessionStatus: 'idle',
      lastMessageSeq: 7,
    });

    expect(h.historyCalls).toEqual([]);
  });

  test('message persisted marks streamed segments stale and schedules a fetch', () => {
    const h = createHarness();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TEXT_DELTA, 's1', {
      messageId: 'm1',
      delta: 'done',
    });
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED, 's1', {
      messageId: 'm1',
      seq: 3,
      role: 'assistant',
    });

    expect(h.state().inProgress.s1?.texts).toEqual([
      { messageId: 'm1', text: 'done', stale: true },
    ]);
    expect(h.state().inProgress.s1?.staleBarrier).toBe(true);
    expect(h.historyCalls).toEqual(['schedule:s1']);
  });

  test('status on a known session refreshes it; unknown session falls back to the list', () => {
    const known = createHarness({ sessions: { s1: makeSession() } });
    dispatchAgentEvent(known.ctx, wsBorsh.AGENT_EVENT_STATUS, 's1', {
      status: 'running',
      lastError: null,
    });
    expect(known.state().sessions.s1?.status).toBe('running');
    expect(known.refreshed).toEqual(['s1']);
    expect(known.loadSessionsCalls).toBe(0);

    const unknown = createHarness();
    dispatchAgentEvent(unknown.ctx, wsBorsh.AGENT_EVENT_STATUS, 'sX', { status: 'running' });
    expect(unknown.loadSessionsCalls).toBe(1);
    expect(unknown.refreshed).toEqual([]);
  });

  test('sync drops buffered deltas, rebuilds inProgress and reloads history', () => {
    const h = createHarness({ sessions: { s1: makeSession() } });

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_TEXT_DELTA, 's1', {
      messageId: 'm1',
      delta: 'stale stream',
    });
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_SYNC, 's1', {
      status: 'waiting_confirmation',
      lastError: null,
      inProgressText: 'resumed',
      inProgressReasoning: '',
      pendingConfirmations: [
        {
          confirmationId: 'c1',
          toolCallId: 't1',
          toolName: 'send_input',
          input: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      queuedMessages: [{ id: 'q1', seq: 1, text: 'later', createdAt: '2026-01-01T00:00:00.000Z' }],
      lastMessageSeq: 2,
    });
    h.flushDeltas();

    expect(h.state().inProgress.s1?.texts).toEqual([
      { messageId: '__sync__', text: 'resumed', stale: false },
    ]);
    expect(h.state().sessions.s1?.status).toBe('waiting_confirmation');
    expect(h.state().pendingConfirmations.s1?.map((item) => item.id)).toEqual(['c1']);
    expect(h.state().queued.s1).toEqual([
      { id: 'q1', sessionId: 's1', seq: 1, text: 'later', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(h.historyCalls).toEqual(['load:s1']);
  });

  test('confirmation request dedupes and resolved removes the entry', () => {
    const h = createHarness();
    const request = {
      confirmationId: 'c1',
      toolCallId: 't1',
      toolName: 'send_input',
      input: { keys: 'rm' },
    };

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST, 's1', request);
    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_CONFIRMATION_REQUEST, 's1', request);
    expect(h.state().pendingConfirmations.s1).toHaveLength(1);

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED, 's1', {
      confirmationId: 'c1',
      status: 'approved',
    });
    expect(h.state().pendingConfirmations.s1).toEqual([]);
  });

  test('queue updated replaces the queue and credential warning notifies', () => {
    const h = createHarness();

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_QUEUE_UPDATED, 's1', {
      queued: [{ id: 'q1', seq: 2, text: 'next', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(h.state().queued.s1).toEqual([
      { id: 'q1', sessionId: 's1', seq: 2, text: 'next', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    dispatchAgentEvent(h.ctx, wsBorsh.AGENT_EVENT_CREDENTIAL_WARNING, 's1', {
      messageId: 'm1',
      types: ['api-token'],
    });
    expect(h.notifications.map((item) => item.level)).toEqual(['warning']);
  });

  test('unknown event types are ignored', () => {
    const h = createHarness();
    expect(dispatchAgentEvent(h.ctx, 999, 's1', {})).toBe(false);
    expect(h.state()).toEqual(createInitialAgentStateData());
  });
});
