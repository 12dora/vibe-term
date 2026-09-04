import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wsBorsh } from '@tmex/shared';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDevice, ensureSiteSettingsInitialized } from '../db';
import {
  type AgentSessionRecord,
  appendAgentMessage,
  createAgentConfirmation,
  createAgentSession,
  ensureAgentSettingsInitialized,
  getAgentConfirmationById,
  getAgentSessionById,
  listAgentMessages,
  listPendingAgentConfirmations,
  listQueuedAgentMessages,
  updateAgentSession,
} from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { eventNotifier } from '../events';
import { notifyNodeOffline } from './node-offline-bus';
import { AgentRun, type AgentRunDeps, type AgentStopReason } from './run';
import {
  AgentAwaitingConfirmationError,
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
  AgentSessionBusyError,
  AgentSessionNotFoundError,
  AgentSessionOrphanedError,
  AgentSupervisor,
} from './supervisor';
import {
  chunk,
  slowSseResponse,
  sseResponse,
  useMockChatServer,
} from './test-support/mock-chat-server';
import type { TerminalRuntimeLike } from './tools/terminal';
import type { AgentWsHub } from './ws-hub';

const createMockChatServer = useMockChatServer();

// ========== 测试基建 ==========

const TEST_DEVICE_ID = 'agent-supervisor-test-device';

interface SupervisorHarness {
  supervisor: AgentSupervisor;
  session: AgentSessionRecord;
  broadcasts: Array<{ sessionId: string; eventType: number; payload: unknown }>;
  runtimeCalls: { sendInput: Array<{ paneId: string; data: string }> };
  hub: Pick<AgentWsHub, 'setSyncProvider' | 'broadcastAgentEvent'> & {
    syncProvider: ((sessionId: string) => Promise<unknown>) | null;
  };
  waitForIdle: () => Promise<void>;
  runDeps: Partial<AgentRunDeps>;
}

function createSupervisorHarness(options: {
  baseUrl: string;
  writeMode?: 'confirm' | 'auto';
  sessionStatus?: AgentSessionRecord['status'];
  createRun?: (sessionId: string) => AgentRun;
  stopTimeoutMs?: number;
}): SupervisorHarness {
  const session = createAgentSession({
    title: 'Supervisor Test',
    deviceId: TEST_DEVICE_ID,
    paneId: '%9',
    modelId: 'mock-model',
    writeMode: options.writeMode ?? 'auto',
  });
  if (options.sessionStatus) {
    updateAgentSession(session.id, { status: options.sessionStatus });
  }

  const broadcasts: SupervisorHarness['broadcasts'] = [];
  const runtimeCalls: SupervisorHarness['runtimeCalls'] = { sendInput: [] };

  const runtime: TerminalRuntimeLike = {
    sendInput(paneId, data) {
      runtimeCalls.sendInput.push({ paneId, data });
    },
    async capturePaneText() {
      return 'captured screen';
    },
    async getPaneInfo() {
      return {
        cols: 80,
        rows: 24,
        cursorX: 0,
        cursorY: 0,
        alternateScreen: false,
        currentCommand: 'bash',
      };
    },
  };

  const hub: SupervisorHarness['hub'] = {
    syncProvider: null,
    setSyncProvider(provider) {
      hub.syncProvider = provider as (sessionId: string) => Promise<unknown>;
    },
    broadcastAgentEvent(sessionId, eventType, payload, _seq) {
      broadcasts.push({ sessionId, eventType, payload });
    },
  };

  const runDeps: Partial<AgentRunDeps> = {
    resolveModel: async () =>
      createOpenAICompatible({
        name: 'mock',
        baseURL: options.baseUrl,
        apiKey: 'mock-key',
      }).chatModel('mock-model'),
    resolveProviderWebSearchTool: async () => null,
    createWebSearchTool: async () => null,
    acquireRuntime: async () => runtime,
    releaseRuntime: async () => {},
    broadcast: (sessionId, eventType, payload, seq) => {
      hub.broadcastAgentEvent(sessionId, eventType, payload, seq);
    },
    notify: async () => {},
    generateTitle: async () => 'Generated Title',
    sleepMs: async () => {},
    deltaFlushIntervalMs: 5,
    retryDelaysMs: [1],
    llmMaxRetries: 0,
    notifyTurnFinished: false,
  };

  const supervisor = new AgentSupervisor({
    deps: {
      hub,
      createRun: options.createRun ?? ((sessionId) => new AgentRun(sessionId, runDeps)),
      stopTimeoutMs: options.stopTimeoutMs ?? 3_000,
    },
  });

  const waitForIdle = async () => {
    for (let i = 0; i < 200; i++) {
      if (!supervisor.isSessionActive(session.id)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('supervisor run did not finish in time');
  };

  return { supervisor, session, broadcasts, runtimeCalls, hub, waitForIdle, runDeps };
}

function createTimedOutHangHarness(baseUrl: string, options?: { idleBeforeHang?: boolean }) {
  let settleFirst: () => void = () => {};
  const firstHang = new Promise<void>((resolve) => {
    settleFirst = resolve;
  });
  let createRunCount = 0;
  let sessionId = '';
  let runDeps: Partial<AgentRunDeps> = {};
  let stopReason: AgentStopReason | null = null;
  const hangingRun = {
    inProgressText: '',
    inProgressReasoning: '',
    requestStop(reason: AgentStopReason) {
      if (stopReason && stopReason !== 'shutdown') {
        return;
      }
      stopReason = reason;
    },
    requestSteer() {},
    execute: async () => {
      if (options?.idleBeforeHang) {
        updateAgentSession(sessionId, { status: 'idle', lastError: null });
      }
      await firstHang;
      if (stopReason === 'manual') {
        updateAgentSession(sessionId, { status: 'stopped', lastError: null });
      } else if (stopReason === 'pane_lost' && !options?.idleBeforeHang) {
        updateAgentSession(sessionId, {
          status: 'error',
          lastError: 'terminal connection lost: pane/device unavailable',
        });
      }
    },
  } as unknown as AgentRun;

  const harness = createSupervisorHarness({
    baseUrl,
    stopTimeoutMs: 20,
    createRun: (id) => {
      if (id !== sessionId) {
        return new AgentRun(id, runDeps);
      }
      createRunCount += 1;
      if (createRunCount === 1) {
        return hangingRun;
      }
      return new AgentRun(id, runDeps);
    },
  });
  sessionId = harness.session.id;
  runDeps = harness.runDeps;
  return {
    harness,
    settleFirst: () => settleFirst(),
    getCreateRunCount: () => createRunCount,
  };
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureSiteSettingsInitialized();
  ensureAgentSettingsInitialized();
  const now = new Date().toISOString();
  createDevice({
    id: TEST_DEVICE_ID,
    name: 'supervisor-test-device',
    type: 'local',
    session: 'tmex-test',
    authMode: 'agent',
    port: 22,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
});

describe('AgentSupervisor - 互斥与基本流程', () => {
  test('submitUserMessage 落库 user 消息并发起 run；运行中再发进入队列', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse([chunk({ role: 'assistant', content: 'thinking...' }), chunk({}, 'stop')], 60)
    );

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    const first = harness.supervisor.submitUserMessage(harness.session.id, 'hello agent');
    expect(first.kind).toBe('message');
    if (first.kind !== 'message') throw new Error('expected message');
    expect(first.record.role).toBe('user');
    expect(first.record.content).toEqual({ role: 'user', content: 'hello agent' });

    // 运行中再发：进入队列而非抛 Busy
    const queued = harness.supervisor.submitUserMessage(harness.session.id, 'again');
    expect(queued.kind).toBe('queued');
    if (queued.kind !== 'queued') throw new Error('expected queued');
    expect(queued.record.text).toBe('again');
    const queueEvents = harness.broadcasts.filter(
      (b) => b.eventType === wsBorsh.AGENT_EVENT_QUEUE_UPDATED
    );
    expect(queueEvents.length).toBeGreaterThan(0);

    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');

    // run 结束后可再次发消息
    const second = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(second.kind).toBe('message');
    if (second.kind !== 'message') throw new Error('expected message');
    expect(second.record.seq).toBeGreaterThan(first.record.seq);
    await harness.waitForIdle();
  });

  test('用户消息疑似含凭证时广播 CREDENTIAL_WARNING（内容不改写）', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')], 60)
    );

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    const notifyCalls: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const originalNotify = eventNotifier.notify.bind(eventNotifier);
    eventNotifier.notify = (async (eventType, event) => {
      notifyCalls.push({ eventType, payload: event.payload as Record<string, unknown> });
    }) as typeof eventNotifier.notify;

    try {
      const text = 'token is ghp_0123456789abcdefghijABCDEFGHIJ0123 please use it';
      const result = harness.supervisor.submitUserMessage(harness.session.id, text);
      if (result.kind !== 'message') throw new Error('expected message');
      const record = result.record;
      expect(record.content).toEqual({ role: 'user', content: text });

      const warnings = harness.broadcasts.filter(
        (b) => b.eventType === wsBorsh.AGENT_EVENT_CREDENTIAL_WARNING
      );
      expect(warnings).toHaveLength(1);
      const payload = warnings[0].payload as { messageId: string; types: string[] };
      expect(payload.messageId).toBe(record.id);
      expect(payload.types).toContain('api-token');

      await harness.waitForIdle();
      expect(notifyCalls.some((call) => call.payload?.kind === 'credential_warning')).toBe(true);
    } finally {
      eventNotifier.notify = originalNotify;
    }
  });

  test('普通用户消息不广播 CREDENTIAL_WARNING', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')], 60)
    );

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'list files in current dir');
    expect(
      harness.broadcasts.filter((b) => b.eventType === wsBorsh.AGENT_EVENT_CREDENTIAL_WARNING)
    ).toHaveLength(0);
    await harness.waitForIdle();
  });

  test('session 不存在抛 NotFound', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    expect(() => harness.supervisor.submitUserMessage(crypto.randomUUID(), 'x')).toThrow(
      AgentSessionNotFoundError
    );
    await expect(harness.supervisor.stopSession(crypto.randomUUID())).rejects.toThrow(
      AgentSessionNotFoundError
    );
  });

  test('waiting_confirmation 且有 pending 时发消息抛 AwaitingConfirmation', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });
    createAgentConfirmation({
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call-x',
      inputJson: { text: 'ls' },
    });
    await harness.supervisor.start();

    expect(() => harness.supervisor.submitUserMessage(harness.session.id, 'hey')).toThrow(
      AgentAwaitingConfirmationError
    );
  });

  test('运行中入队 → step 边界注入续跑（两条 user 消息都被处理，队列清空）', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')], 60)
    );
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    const first = harness.supervisor.submitUserMessage(harness.session.id, 'first');
    expect(first.kind).toBe('message');
    // 运行中入队第二条
    const queued = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(queued.kind).toBe('queued');

    await harness.waitForIdle();

    const userTexts = listAgentMessages(harness.session.id)
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as { content?: unknown }).content);
    expect(userTexts).toEqual(['first', 'second']);
    expect(listQueuedAgentMessages(harness.session.id)).toHaveLength(0);
  });

  test('orphan 会话（无设备绑定）拒绝发消息', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();

    const orphan = createAgentSession({
      title: 'orphan',
      deviceId: null,
      paneId: null,
      modelId: 'mock-model',
    });
    expect(() => harness.supervisor.submitUserMessage(orphan.id, 'hi')).toThrow(
      AgentSessionOrphanedError
    );
  });
});

describe('AgentSupervisor - 确认决策续跑', () => {
  function setupConfirmFlow() {
    const mock = createMockChatServer((callIndex, req) => {
      const hasToolMessage = req.body.messages.some((m) => m.role === 'tool');
      if (callIndex === 0 || !hasToolMessage) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_send_1',
                type: 'function',
                function: { name: 'send_input', arguments: '{"text":"ls","keys":["enter"]}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop')]);
    });
    return mock;
  }

  test('approve：CAS decide → 合并落库 approval-response → 续跑执行工具 → idle', async () => {
    const mock = setupConfirmFlow();
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();

    harness.supervisor.submitUserMessage(harness.session.id, 'run ls');
    await harness.waitForIdle();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');
    const pending = listPendingAgentConfirmations(harness.session.id);
    expect(pending.length).toBe(1);

    const decided = harness.supervisor.resolveConfirmation(pending[0]!.id, true);
    expect(decided.status).toBe('approved');

    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');

    // 工具被真实执行（approve 续跑时 initial 阶段执行）
    expect(harness.runtimeCalls.sendInput).toEqual([{ paneId: '%9', data: 'ls\r' }]);

    // tool-approval-response 已落库
    const messages = listAgentMessages(harness.session.id);
    const approvalResponse = messages.find((m) => {
      const content = (m.content as { content?: Array<{ type?: string }> }).content;
      return Array.isArray(content) && content.some((p) => p?.type === 'tool-approval-response');
    });
    expect(approvalResponse).toBeDefined();

    // 广播 confirmation_resolved
    const resolved = harness.broadcasts.filter(
      (b) => b.eventType === wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED
    );
    expect(resolved.length).toBe(1);
    expect((resolved[0]!.payload as { status: string }).status).toBe('approved');
  });

  test('deny：工具不执行，模型收到拒绝后继续', async () => {
    const mock = setupConfirmFlow();
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();

    harness.supervisor.submitUserMessage(harness.session.id, 'run ls');
    await harness.waitForIdle();

    const pending = listPendingAgentConfirmations(harness.session.id);
    const decided = harness.supervisor.resolveConfirmation(pending[0]!.id, false, 'too risky');
    expect(decided.status).toBe('denied');
    expect(decided.reason).toBe('too risky');

    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    expect(harness.runtimeCalls.sendInput.length).toBe(0);
  });

  test('重复 decide 抛 AlreadyDecided（409 语义）；不存在的 confirmation 抛 NotFound', async () => {
    const mock = setupConfirmFlow();
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();

    harness.supervisor.submitUserMessage(harness.session.id, 'run ls');
    await harness.waitForIdle();

    const pending = listPendingAgentConfirmations(harness.session.id);
    harness.supervisor.resolveConfirmation(pending[0]!.id, true);

    expect(() => harness.supervisor.resolveConfirmation(pending[0]!.id, false)).toThrow(
      AgentConfirmationAlreadyDecidedError
    );
    expect(() => harness.supervisor.resolveConfirmation(crypto.randomUUID(), true)).toThrow(
      AgentConfirmationNotFoundError
    );
    await harness.waitForIdle();
  });
});

describe('AgentSupervisor - stop 语义', () => {
  test('stopSession：活动 run 被 abort，累积文本落库 truncated，status=stopped', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'aaa ' }),
          chunk({ content: 'bbb ' }),
          chunk({ content: 'ccc ' }),
          chunk({ content: 'ddd' }),
          chunk({}, 'stop'),
        ],
        50
      )
    );

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');

    await new Promise((r) => setTimeout(r, 100));
    await harness.supervisor.stopSession(harness.session.id);

    expect(getAgentSessionById(harness.session.id)?.status).toBe('stopped');
    const truncated = listAgentMessages(harness.session.id).find(
      (m) => (m.content as { truncated?: boolean }).truncated === true
    );
    expect(truncated).toBeDefined();
  });

  test('stopSession：waiting_confirmation 时取消 pending 并补 denied response', async () => {
    const mock = createMockChatServer((_, req) => {
      const hasToolMessage = req.body.messages.some((m) => m.role === 'tool');
      if (!hasToolMessage) {
        return sseResponse([
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_send_2',
                type: 'function',
                function: { name: 'send_input', arguments: '{"text":"rm -rf /tmp/x"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')]);
    });

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl, writeMode: 'confirm' });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'clean tmp');
    await harness.waitForIdle();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');
    const pending = listPendingAgentConfirmations(harness.session.id);
    expect(pending.length).toBe(1);

    await harness.supervisor.stopSession(harness.session.id);

    expect(getAgentSessionById(harness.session.id)?.status).toBe('stopped');
    expect(listPendingAgentConfirmations(harness.session.id).length).toBe(0);
    expect(getAgentConfirmationById(pending[0]!.id)?.status).toBe('cancelled');

    // 消息流补了 approval-response，后续发消息不会因悬空 approval-request 失败
    harness.supervisor.submitUserMessage(harness.session.id, 'try again');
    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
  });

  test('supervisor.stop()（shutdown）：abort 活动 run 且 status 保持 running', async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'xxx' }),
          chunk({ content: 'yyy' }),
          chunk({}, 'stop'),
        ],
        60
      )
    );

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');

    await new Promise((r) => setTimeout(r, 80));
    await harness.supervisor.stop();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('running');
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
  });

  test('stop() 超时后拒绝新提交，旧 entry 仅在 run settle 后按身份删除', async () => {
    let settleRun: () => void = () => {};
    const hanging = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    let createRunCount = 0;
    const hangingRun = {
      inProgressText: '',
      inProgressReasoning: '',
      requestStop() {},
      requestSteer() {},
      execute: () => hanging,
    } as unknown as AgentRun;

    const harness = createSupervisorHarness({
      baseUrl: 'http://unused',
      stopTimeoutMs: 20,
      createRun: () => {
        createRunCount += 1;
        return hangingRun;
      },
    });
    harness.supervisor.submitUserMessage(harness.session.id, 'hang');
    expect(createRunCount).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    await harness.supervisor.stop();

    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);
    expect(() => harness.supervisor.submitUserMessage(harness.session.id, 'again')).toThrow(
      AgentSessionBusyError
    );
    expect(createRunCount).toBe(1);

    settleRun();
    await harness.waitForIdle();
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    expect(createRunCount).toBe(1);
  });

  test('stop() 超时后 start() 再提交：旧 run settle 后消费排队消息，不会永远无消费者', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    const { harness, settleFirst, getCreateRunCount } = createTimedOutHangHarness(mock.baseUrl);

    await harness.supervisor.start();
    const first = harness.supervisor.submitUserMessage(harness.session.id, 'first');
    expect(first.kind).toBe('message');
    expect(getCreateRunCount()).toBe(1);

    await harness.supervisor.stop();
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    await harness.supervisor.start();

    const second = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(second.kind).toBe('queued');
    expect(listQueuedAgentMessages(harness.session.id).map((q) => q.text)).toEqual(['second']);
    expect(getCreateRunCount()).toBe(1);

    settleFirst();
    await harness.waitForIdle();

    expect(getCreateRunCount()).toBe(2);
    expect(listQueuedAgentMessages(harness.session.id)).toHaveLength(0);
    const userTexts = listAgentMessages(harness.session.id)
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as { content?: unknown }).content);
    expect(userTexts).toEqual(['first', 'second']);
  });

  test('stop() 超时后旧 run 先 settle，start() 仍会消费已排队消息', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    const { harness, settleFirst, getCreateRunCount } = createTimedOutHangHarness(mock.baseUrl);

    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'first');
    const queued = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(queued.kind).toBe('queued');
    expect(getCreateRunCount()).toBe(1);

    await harness.supervisor.stop();
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    settleFirst();
    await harness.waitForIdle();
    expect(getCreateRunCount()).toBe(1);
    expect(listQueuedAgentMessages(harness.session.id).map((q) => q.text)).toEqual(['second']);

    await harness.supervisor.start();
    await harness.waitForIdle();

    expect(getCreateRunCount()).toBe(2);
    expect(listQueuedAgentMessages(harness.session.id)).toHaveLength(0);
    const userTexts = listAgentMessages(harness.session.id)
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as { content?: unknown }).content);
    expect(userTexts).toEqual(['first', 'second']);
  });

  test('stop() 超时后 start()：stale run settle 后恢复 status=running 的 session', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    const { harness, settleFirst, getCreateRunCount } = createTimedOutHangHarness(mock.baseUrl);

    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'first');
    updateAgentSession(harness.session.id, { status: 'running' });
    expect(getCreateRunCount()).toBe(1);

    await harness.supervisor.stop();
    await harness.supervisor.start();
    expect(getCreateRunCount()).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    settleFirst();
    await harness.waitForIdle();

    expect(getCreateRunCount()).toBe(2);
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
  });

  test('stop() 超时后 start()：resume 窗口内 stopSession 不得再拉起 run', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    const { harness, settleFirst, getCreateRunCount } = createTimedOutHangHarness(mock.baseUrl);

    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'first');
    const queued = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(queued.kind).toBe('queued');
    updateAgentSession(harness.session.id, { status: 'running' });

    await harness.supervisor.stop();
    await harness.supervisor.start();
    expect(getCreateRunCount()).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    const stopping = harness.supervisor.stopSession(harness.session.id);
    settleFirst();
    await stopping;
    await harness.waitForIdle();

    expect(getCreateRunCount()).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    expect(getAgentSessionById(harness.session.id)?.status).toBe('stopped');
    expect(listQueuedAgentMessages(harness.session.id).map((q) => q.text)).toEqual(['second']);
  });

  test('stop() 超时后 start()：resume 窗口内 pane_lost 不得再拉起 run', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    const { harness, settleFirst, getCreateRunCount } = createTimedOutHangHarness(mock.baseUrl);

    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'first');
    const queued = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(queued.kind).toBe('queued');
    updateAgentSession(harness.session.id, { status: 'running' });

    await harness.supervisor.stop();
    await harness.supervisor.start();
    expect(getCreateRunCount()).toBe(1);

    harness.supervisor.stopSessionsForDevice(TEST_DEVICE_ID, 'pane_lost');
    settleFirst();
    await harness.waitForIdle();

    expect(getCreateRunCount()).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(session?.lastError).toMatch(/terminal connection lost|pane\/device unavailable/);
    expect(listQueuedAgentMessages(harness.session.id).map((q) => q.text)).toEqual(['second']);
  });

  test('stop() 超时后 start()：run 已 idle 但仍在 activeRuns 时 pane_lost 不得从队列再拉起', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );
    const { harness, settleFirst, getCreateRunCount } = createTimedOutHangHarness(mock.baseUrl, {
      idleBeforeHang: true,
    });

    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'first');
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    const queued = harness.supervisor.submitUserMessage(harness.session.id, 'second');
    expect(queued.kind).toBe('queued');

    await harness.supervisor.stop();
    await harness.supervisor.start();
    expect(getCreateRunCount()).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(true);

    harness.supervisor.stopSessionsForDevice(TEST_DEVICE_ID, 'pane_lost');
    settleFirst();
    await harness.waitForIdle();

    expect(getCreateRunCount()).toBe(1);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    expect(listQueuedAgentMessages(harness.session.id).map((q) => q.text)).toEqual(['second']);
  });

  test("stopSessionsForDevice('pane_lost')：活动 run 被 abort 且 status=error（不自动恢复）", async () => {
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'working ' }),
          chunk({ content: 'more ' }),
          chunk({}, 'stop'),
        ],
        50
      )
    );

    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');

    await new Promise((r) => setTimeout(r, 80));
    harness.supervisor.stopSessionsForDevice(TEST_DEVICE_ID, 'pane_lost');

    await harness.waitForIdle();

    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(session?.lastError).toMatch(/terminal connection lost|pane\/device unavailable/);
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
  });

  test('stopSessionsForDevice：无活动 run 时直接落 error 并广播', async () => {
    const harness = createSupervisorHarness({
      baseUrl: 'http://unused',
      sessionStatus: 'running',
    });

    const beforeCount = harness.broadcasts.length;
    harness.supervisor.stopSessionsForDevice(TEST_DEVICE_ID, 'pane_lost');

    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(session?.lastError).toMatch(/terminal connection lost|pane\/device unavailable/);

    const newEvents = harness.broadcasts
      .slice(beforeCount)
      .filter(
        (b) =>
          b.sessionId === harness.session.id &&
          b.payload !== null &&
          typeof b.payload === 'object' &&
          (b.payload as { status?: string }).status === 'error'
      );
    expect(newEvents.length).toBeGreaterThan(0);
  });

  test('stopSessionsForDevice：不影响其他 device 的 session', async () => {
    const OTHER_DEVICE_ID = 'agent-supervisor-other-device';
    createDevice({
      id: OTHER_DEVICE_ID,
      name: 'other-device',
      type: 'local',
      session: 'tmex-test',
      authMode: 'agent',
      port: 22,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')])
    );

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'running',
    });

    const otherSession = createAgentSession({
      title: 'Other Device',
      deviceId: OTHER_DEVICE_ID,
      paneId: '%2',
      modelId: 'mock-model',
      writeMode: 'auto',
    });
    updateAgentSession(otherSession.id, { status: 'running' });

    harness.supervisor.stopSessionsForDevice(TEST_DEVICE_ID, 'pane_lost');

    const mine = getAgentSessionById(harness.session.id);
    const others = getAgentSessionById(otherSession.id);
    expect(mine?.status).toBe('error');
    expect(others?.status).toBe('running');
  });

  test('stopSessionsForNode：无活动 run 时 running 落 error NODE_OFFLINE 并广播', async () => {
    const NODE_ID = 'peer-offline-1';
    const harness = createSupervisorHarness({
      baseUrl: 'http://unused',
      sessionStatus: 'running',
    });
    updateAgentSession(harness.session.id, { nodeId: NODE_ID });

    const other = createAgentSession({
      title: 'Other node',
      deviceId: TEST_DEVICE_ID,
      paneId: '%2',
      modelId: 'mock-model',
      nodeId: 'other-peer',
    });
    updateAgentSession(other.id, { status: 'running' });

    const beforeCount = harness.broadcasts.length;
    harness.supervisor.stopSessionsForNode(NODE_ID);

    expect(getAgentSessionById(harness.session.id)?.status).toBe('error');
    expect(getAgentSessionById(harness.session.id)?.lastError).toBe('NODE_OFFLINE');
    expect(getAgentSessionById(other.id)?.status).toBe('running');

    const newEvents = harness.broadcasts
      .slice(beforeCount)
      .filter(
        (b) =>
          b.sessionId === harness.session.id &&
          b.payload !== null &&
          typeof b.payload === 'object' &&
          (b.payload as { lastError?: string }).lastError === 'NODE_OFFLINE'
      );
    expect(newEvents.length).toBeGreaterThan(0);
  });

  test('stopSessionsForNode：活动 run 被 abort 且 lastError=NODE_OFFLINE', async () => {
    const NODE_ID = 'peer-offline-run';
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'working ' }),
          chunk({ content: 'more ' }),
          chunk({}, 'stop'),
        ],
        50
      )
    );
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    updateAgentSession(harness.session.id, { nodeId: NODE_ID });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');
    await new Promise((r) => setTimeout(r, 80));
    harness.supervisor.stopSessionsForNode(NODE_ID);
    await harness.waitForIdle();
    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('error');
    expect(session?.lastError).toBe('NODE_OFFLINE');
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
  });
});

describe('AgentSupervisor - 重启恢复', () => {
  test("恢复 status='running' 的 session：从已落库 messages 重新发起 run", async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'resumed' }), chunk({}, 'stop')])
    );

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'running',
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'continue please' });

    await harness.supervisor.start();
    await harness.waitForIdle();

    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    const lastAssistant = listAgentMessages(harness.session.id)
      .filter((m) => m.role === 'assistant')
      .at(-1);
    expect((lastAssistant?.content as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'resumed'
    );
    // 重新发起的请求带上了已落库的 user 消息
    expect(mock.requests[0]!.body.messages.some((m) => m.role === 'user')).toBe(true);
  });

  test("恢复 status='running' 且残留 pending confirmations：先作废再重跑", async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'recovered' }), chunk({}, 'stop')])
    );

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      writeMode: 'confirm',
      sessionStatus: 'running',
    });
    // 模拟 crash 现场：approval-request 已落库、confirmation pending，但 status 仍是 running
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'run ls' });
    appendAgentMessage(harness.session.id, 'assistant', {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_crash_1',
          toolName: 'send_input',
          input: { text: 'ls', keys: ['enter'] },
        },
        {
          type: 'tool-approval-request',
          approvalId: 'approval_crash_1',
          toolCallId: 'call_crash_1',
        },
      ],
    });
    const confirmation = createAgentConfirmation({
      id: 'approval_crash_1',
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call_crash_1',
      inputJson: { text: 'ls', keys: ['enter'] },
    });

    await harness.supervisor.start();
    await harness.waitForIdle();

    // 残留 confirmation 被作废并广播
    expect(getAgentConfirmationById(confirmation.id)?.status).toBe('cancelled');
    expect(listPendingAgentConfirmations(harness.session.id).length).toBe(0);
    const resolved = harness.broadcasts.filter(
      (b) => b.eventType === wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED
    );
    expect(resolved.length).toBe(1);
    expect((resolved[0]!.payload as { status: string }).status).toBe('cancelled');

    // 悬空 tool call 被补上 SDK 原生 execution-denied output，重跑请求合法
    const toolMessages = listAgentMessages(harness.session.id).filter((m) => m.role === 'tool');
    const denied = toolMessages
      .flatMap(
        (m) =>
          (
            m.content as {
              content: Array<{ type: string; output?: { type: string; reason?: string } }>;
            }
          ).content
      )
      .find((p) => p.type === 'tool-result');
    expect(denied?.output).toEqual({
      type: 'execution-denied',
      reason: 'invalidated after restart',
    });

    // run 正常完成
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
    expect(mock.requests.length).toBeGreaterThanOrEqual(1);
  });

  test("恢复 status='waiting_confirmation'：pending 仍在则保持等待，不发起 run、不重发通知", async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });
    createAgentConfirmation({
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call-y',
      inputJson: { text: 'ls' },
    });

    await harness.supervisor.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(getAgentSessionById(harness.session.id)?.status).toBe('waiting_confirmation');
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    expect(mock.requests.length).toBe(0);
    expect(listPendingAgentConfirmations(harness.session.id).length).toBe(1);
  });

  test("恢复 status='waiting_confirmation' 但 pending 丢失：自愈置 idle", async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });

    await harness.supervisor.start();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
  });
});

describe('AgentSupervisor - syncProvider', () => {
  test('注入的 syncProvider 返回 status/pending/lastMessageSeq', async () => {
    const mock = createMockChatServer(() => sseResponse([chunk({}, 'stop')]));

    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'waiting_confirmation',
    });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'hi' });
    const confirmation = createAgentConfirmation({
      sessionId: harness.session.id,
      toolName: 'send_input',
      toolCallId: 'call-z',
      inputJson: { text: 'pwd' },
    });

    await harness.supervisor.start();
    expect(harness.hub.syncProvider).not.toBeNull();

    const sync = (await harness.hub.syncProvider!(harness.session.id)) as {
      status: string;
      inProgressText: string;
      pendingConfirmations: Array<{ confirmationId: string }>;
      lastMessageSeq: number;
    };
    expect(sync.status).toBe('waiting_confirmation');
    expect(sync.inProgressText).toBe('');
    expect(sync.pendingConfirmations.map((c) => c.confirmationId)).toEqual([confirmation.id]);
    expect(sync.lastMessageSeq).toBe(0);

    const missing = await harness.hub.syncProvider!(crypto.randomUUID());
    expect(missing).toBeNull();
  });
});

describe('AgentSupervisor - 远端恢复与 shutdown 离线通知', () => {
  test('start() 不恢复远端 running session，restoreRemoteSessions 之后才拉起', async () => {
    const mock = createMockChatServer(() =>
      sseResponse([chunk({ role: 'assistant', content: 'remote-resumed' }), chunk({}, 'stop')])
    );
    const harness = createSupervisorHarness({
      baseUrl: mock.baseUrl,
      sessionStatus: 'running',
    });
    updateAgentSession(harness.session.id, { nodeId: 'peer-restore-1' });
    appendAgentMessage(harness.session.id, 'user', { role: 'user', content: 'continue remote' });

    await harness.supervisor.start();
    expect(harness.supervisor.isSessionActive(harness.session.id)).toBe(false);
    expect(getAgentSessionById(harness.session.id)?.status).toBe('running');

    harness.supervisor.restoreRemoteSessions();
    await harness.waitForIdle();
    expect(getAgentSessionById(harness.session.id)?.status).toBe('idle');
  });

  test('supervisor stopping 时忽略 NODE_OFFLINE，session 保持 running', async () => {
    const NODE_ID = 'peer-stopping-offline';
    const mock = createMockChatServer(() =>
      slowSseResponse(
        [
          chunk({ role: 'assistant', content: 'working ' }),
          chunk({ content: 'more ' }),
          chunk({}, 'stop'),
        ],
        80
      )
    );
    const harness = createSupervisorHarness({ baseUrl: mock.baseUrl });
    updateAgentSession(harness.session.id, { nodeId: NODE_ID });
    await harness.supervisor.start();
    harness.supervisor.submitUserMessage(harness.session.id, 'talk');
    await new Promise((r) => setTimeout(r, 30));
    await harness.supervisor.stop();
    notifyNodeOffline(NODE_ID);
    const session = getAgentSessionById(harness.session.id);
    expect(session?.status).toBe('running');
    expect(session?.lastError).not.toBe('NODE_OFFLINE');
  });
});
