import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { AgentSessionRecord } from '../db/agent';
import {
  type RunFinishSink,
  finishAbortedRun,
  finishErrorRun,
  finishIdleRun,
  persistTruncatedAssistantText,
} from './run-finish';

function fakeSession(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'sess-1',
    title: 'Test',
    nodeId: null,
    deviceId: null,
    paneId: null,
    providerId: null,
    modelId: 'm',
    systemPrompt: null,
    writeMode: 'auto',
    useProviderWebSearch: false,
    providerHostedTools: [],
    allowControlChars: false,
    originPaneTitle: null,
    originProcessName: null,
    status: 'running',
    lastError: null,
    maxStepsPerTurn: 25,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function fakeSink(
  inProgress = '',
  extras: Partial<Pick<RunFinishSink, 'terminalFatal' | 'terminalFatalMessage' | 'stopReason'>> = {}
) {
  const events: string[] = [];
  let text = inProgress;
  const sink: RunFinishSink = {
    sessionId: 'sess-1',
    terminalFatal: false,
    terminalFatalMessage: '',
    stopReason: null,
    clearTimer: () => events.push('clearTimer'),
    consumeInProgressText: () => {
      const current = text;
      text = '';
      events.push(`consume:${current}`);
      return current;
    },
    lastMessageSeq: () => 7,
    setStatus: (status, lastError) => {
      events.push(`status:${status}:${lastError ?? ''}`);
    },
    broadcast: (eventType, payload) => {
      events.push(`broadcast:${eventType}:${JSON.stringify(payload)}`);
    },
    notify: (eventType) => {
      events.push(`notify:${eventType}`);
    },
    ...extras,
  };
  return { sink, events };
}

describe('run-finish', () => {
  test('空截断文本不广播', () => {
    const { sink, events } = fakeSink('');
    persistTruncatedAssistantText(sink);
    expect(events).toEqual(['consume:']);
  });

  test('idle 设状态并可选通知', () => {
    const { sink, events } = fakeSink();
    expect(finishIdleRun(sink, fakeSession(), false)).toBe('idle');
    expect(events.some((e) => e.startsWith('notify:'))).toBe(false);
    expect(events).toContain('status:idle:');
    expect(events.some((e) => e.startsWith(`broadcast:${wsBorsh.AGENT_EVENT_TURN_FINISHED}`))).toBe(
      true
    );
  });

  test('abort 子优先级：fatal > shutdown > pane_lost > stopped', () => {
    const session = fakeSession();
    const fatal = fakeSink('', {
      terminalFatal: true,
      terminalFatalMessage: 'fatal-msg',
      stopReason: 'shutdown',
    });
    expect(finishAbortedRun(fatal.sink, session)).toBe('error');
    expect(fatal.events).toContain('status:error:fatal-msg');

    const shutdown = fakeSink('', { stopReason: 'shutdown' });
    expect(finishAbortedRun(shutdown.sink, session)).toBe('interrupted');

    const paneLost = fakeSink('', { stopReason: 'pane_lost' });
    expect(finishAbortedRun(paneLost.sink, session)).toBe('error');
    expect(paneLost.events.some((e) => e.includes('pane/device unavailable'))).toBe(true);

    const nodeOffline = fakeSink('', { stopReason: 'node_offline' });
    expect(finishAbortedRun(nodeOffline.sink, session)).toBe('error');
    expect(nodeOffline.events).toContain('status:error:NODE_OFFLINE');

    const stopped = fakeSink('', { stopReason: 'manual' });
    expect(finishAbortedRun(stopped.sink, session)).toBe('stopped');
    expect(stopped.events).toContain('status:stopped:');
  });

  test('finishError 清 timer、落截断（空则跳过）并通知', () => {
    const { sink, events } = fakeSink('');
    expect(finishErrorRun(sink, fakeSession(), 'boom')).toBe('error');
    expect(events[0]).toBe('clearTimer');
    expect(events).toContain('status:error:boom');
    expect(events).toContain('notify:agent_error');
  });
});
