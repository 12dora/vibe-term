// Agent 会话调度器（单例，仿 pushSupervisor）
// 职责：单 session 互斥、用户消息/停止/确认决策入口、重启恢复、向 ws-hub 注入真实 syncProvider。
//
// AI SDK 续跑约束：collectToolApprovals 只读取"最后一条 role=tool 消息"中的
// tool-approval-response，因此同一回合的多个确认必须等全部决定后合并为一条 tool 消息落库，
// 才能发起续跑（见 appendApprovalResponsesIfReady）。

import { wsBorsh } from '@tmex/shared';
import { getDeviceById, getSiteSettings } from '../db';
import {
  type AgentConfirmationRecord,
  type AgentMessageRecord,
  type AgentQueuedMessageRecord,
  type AgentSessionRecord,
  appendAgentMessage,
  decideAgentConfirmation,
  deleteQueuedAgentMessage,
  enqueueAgentMessage,
  getAgentConfirmationById,
  getAgentSessionById,
  getAgentSessionsByStatus,
  getMaxAgentMessageSeq,
  getQueuedAgentMessageById,
  listAgentMessages,
  listPendingAgentConfirmations,
  listQueuedAgentMessages,
  updateAgentSession,
  updateQueuedAgentMessage,
} from '../db/agent';
import { t } from '../i18n';
import { telegramService } from '../telegram/service';
import {
  type ApprovalConfirmationLike,
  buildApprovalResponsePlan,
  inspectApprovalMessages,
} from './approval-response-reconciler';
import { registerDeviceCloseListener } from './device-close-bus';
import type { AgentStopReason } from './run';
import { AgentRun, type AgentRunDeps } from './run';
import { detectSecrets } from './secret-scan';
import { type AgentWsHub, agentWsHub } from './ws-hub';

export class AgentSessionNotFoundError extends Error {
  constructor() {
    super(t('apiError.agentSessionNotFound'));
    this.name = 'AgentSessionNotFoundError';
  }
}

export class AgentSessionBusyError extends Error {
  constructor() {
    super(t('apiError.agentSessionBusy'));
    this.name = 'AgentSessionBusyError';
  }
}

export class AgentAwaitingConfirmationError extends Error {
  constructor() {
    super(t('apiError.agentSessionAwaitingConfirmation'));
    this.name = 'AgentAwaitingConfirmationError';
  }
}

export class AgentConfirmationNotFoundError extends Error {
  constructor() {
    super(t('apiError.agentConfirmationNotFound'));
    this.name = 'AgentConfirmationNotFoundError';
  }
}

export class AgentConfirmationAlreadyDecidedError extends Error {
  constructor() {
    super(t('apiError.agentConfirmationAlreadyDecided'));
    this.name = 'AgentConfirmationAlreadyDecidedError';
  }
}

export class AgentSessionOrphanedError extends Error {
  constructor() {
    super(t('apiError.agentSessionOrphaned'));
    this.name = 'AgentSessionOrphanedError';
  }
}

export class AgentQueuedMessageNotFoundError extends Error {
  constructor() {
    super(t('apiError.agentQueuedMessageNotFound'));
    this.name = 'AgentQueuedMessageNotFoundError';
  }
}

/** 提交用户消息的结果：idle 时直接落库发起 run；running 时进入队列 */
export type SubmitUserMessageResult =
  | { kind: 'message'; record: AgentMessageRecord }
  | { kind: 'queued'; record: AgentQueuedMessageRecord };

/** 会话是否孤立：绑定设备被删 / 缺失（后端可靠判定；pane 关闭但设备在线由前端判定屏蔽） */
function isSessionOrphan(session: AgentSessionRecord): boolean {
  return !session.deviceId || !getDeviceById(session.deviceId);
}

function toQueuedWire(record: AgentQueuedMessageRecord): {
  id: string;
  seq: number;
  text: string;
  createdAt: string;
} {
  return { id: record.id, seq: record.seq, text: record.text, createdAt: record.createdAt };
}

interface ActiveRun {
  run: AgentRun;
  promise: Promise<unknown>;
  stale: boolean;
  resumeSuppressed: boolean;
  deviceId: string | null;
}

interface AgentSupervisorDeps {
  hub: Pick<AgentWsHub, 'setSyncProvider' | 'broadcastAgentEvent'>;
  createRun: (sessionId: string) => AgentRun;
  stopTimeoutMs: number;
}

export interface AgentSupervisorOptions {
  deps?: Partial<AgentSupervisorDeps>;
  runDeps?: Partial<AgentRunDeps>;
}

export class AgentSupervisor {
  private readonly deps: AgentSupervisorDeps;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly staleSessionIds = new Set<string>();
  private readonly resumeSuppressedSessionIds = new Set<string>();
  private readonly lostDeviceIds = new Set<string>();
  private started = false;
  private stopping = false;

  constructor(options: AgentSupervisorOptions = {}) {
    const runDeps = options.runDeps ?? {};
    this.deps = {
      hub: agentWsHub,
      createRun: (sessionId) => new AgentRun(sessionId, runDeps),
      stopTimeoutMs: 5_000,
      ...(options.deps ?? {}),
    };
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;

    this.deps.hub.setSyncProvider(async (sessionId) => {
      const session = getAgentSessionById(sessionId);
      if (!session) {
        return null;
      }
      const active = this.activeRuns.get(sessionId);
      return {
        status: session.status,
        lastError: session.lastError,
        inProgressText: active?.run.inProgressText ?? '',
        inProgressReasoning: active?.run.inProgressReasoning ?? '',
        pendingConfirmations: listPendingAgentConfirmations(sessionId).map((c) => ({
          confirmationId: c.id,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.inputJson,
          createdAt: c.createdAt,
        })),
        queuedMessages: listQueuedAgentMessages(sessionId).map(toQueuedWire),
        lastMessageSeq: getMaxAgentMessageSeq(sessionId),
      };
    });

    // 重启恢复：running → 从已落库 messages 重新发起 run（等价重试最后 step）。
    // crash 可能发生在 confirmations 落库之后、status 置 waiting_confirmation 之前，
    // 残留 pending 已无运行中的 run 对应，先作废并补 execution-denied result 防止消息流悬空
    for (const session of getAgentSessionsByStatus('running')) {
      const cancelled = this.cancelPendingConfirmations(session.id, 'invalidated after restart');
      if (cancelled > 0) {
        this.appendApprovalResponsesIfReady(session.id);
      }
      this.startRun(session.id);
    }

    // waiting_confirmation：pending confirmations 仍在则保持等待（不重发通知——
    // confirmations 表有记录代表已通知过）；pending 缺失说明 crash 在中间态，尝试自愈
    for (const session of getAgentSessionsByStatus('waiting_confirmation')) {
      const pending = listPendingAgentConfirmations(session.id);
      if (pending.length > 0) {
        continue;
      }
      if (this.appendApprovalResponsesIfReady(session.id)) {
        this.startRun(session.id);
      } else {
        updateAgentSession(session.id, { status: 'idle' });
      }
    }

    // stop() 超时留下的 stale session：仍在跑的等它 settle 再续；已 settle 的立即恢复
    for (const sessionId of [...this.staleSessionIds]) {
      this.resumeSessionIfNeeded(sessionId);
    }

    // 订阅设备关闭事件：设备 runtime 断开时主动停止绑定该设备的 session
    registerDeviceCloseListener((deviceId) => this.stopSessionsForDevice(deviceId, 'pane_lost'));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;

    const promises: Promise<unknown>[] = [];
    for (const active of this.activeRuns.values()) {
      active.run.requestStop('shutdown');
      promises.push(active.promise);
    }

    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise((resolve) => setTimeout(resolve, this.deps.stopTimeoutMs)),
      ]);
    }

    for (const [sessionId, entry] of this.activeRuns) {
      entry.stale = true;
      this.staleSessionIds.add(sessionId);
    }
  }

  /**
   * 提交用户消息：
   * - 运行中 → 入队（可选 steer 立即注入）；
   * - 空闲/停止/出错 → 直接落库并发起 run。
   * orphan 会话拒绝输入。
   */
  submitUserMessage(sessionId: string, text: string, steer = false): SubmitUserMessageResult {
    const session = getAgentSessionById(sessionId);
    if (!session) {
      throw new AgentSessionNotFoundError();
    }
    if (isSessionOrphan(session)) {
      throw new AgentSessionOrphanedError();
    }
    if (this.stopping) {
      throw new AgentSessionBusyError();
    }

    // 运行中：入队，不打断（steer=true 时请求立即注入）
    if (this.activeRuns.has(sessionId)) {
      const queued = enqueueAgentMessage(sessionId, text);
      this.warnIfCredentialText(session, text);
      this.broadcastQueue(sessionId);
      if (steer) {
        this.activeRuns.get(sessionId)?.run.requestSteer();
      }
      return { kind: 'queued', record: queued };
    }

    if (session.status === 'waiting_confirmation') {
      if (listPendingAgentConfirmations(sessionId).length > 0) {
        throw new AgentAwaitingConfirmationError();
      }
      // pending 已空但消息流可能仍有悬空 approval-request，补齐 responses 防止模型请求失败
      this.appendApprovalResponsesIfReady(sessionId);
    }

    const record = appendAgentMessage(sessionId, 'user', { role: 'user', content: text });
    this.broadcastPersisted(sessionId, record);
    // 用户输入凭证检测：不改写内容（照常发 LLM + 落库），仅 UI + 推送告警数据可能泄露。
    this.warnIfCredential(session, record, text);
    this.startRun(sessionId);
    return { kind: 'message', record };
  }

  /** 编辑队列中的消息（仅改文本） */
  editQueuedMessage(itemId: string, text: string): AgentQueuedMessageRecord {
    const existing = getQueuedAgentMessageById(itemId);
    if (!existing) {
      throw new AgentQueuedMessageNotFoundError();
    }
    const updated = updateQueuedAgentMessage(itemId, text);
    if (!updated) {
      throw new AgentQueuedMessageNotFoundError();
    }
    this.broadcastQueue(existing.sessionId);
    return updated;
  }

  /** 撤回队列中的消息 */
  withdrawQueuedMessage(itemId: string): void {
    const existing = getQueuedAgentMessageById(itemId);
    if (!existing) {
      throw new AgentQueuedMessageNotFoundError();
    }
    deleteQueuedAgentMessage(itemId);
    this.broadcastQueue(existing.sessionId);
  }

  private broadcastQueue(sessionId: string): void {
    this.deps.hub.broadcastAgentEvent(
      sessionId,
      wsBorsh.AGENT_EVENT_QUEUE_UPDATED,
      { queued: listQueuedAgentMessages(sessionId).map(toQueuedWire) },
      0
    );
  }

  private warnIfCredentialText(session: AgentSessionRecord, text: string): void {
    const matches = detectSecrets(text);
    if (matches.length === 0) {
      return;
    }
    const types = [...new Set(matches.map((m) => m.type))];
    void this.pushCredentialWarning(session, types);
  }

  private warnIfCredential(
    session: AgentSessionRecord,
    record: AgentMessageRecord,
    text: string
  ): void {
    const matches = detectSecrets(text);
    if (matches.length === 0) {
      return;
    }
    const types = [...new Set(matches.map((m) => m.type))];
    this.deps.hub.broadcastAgentEvent(
      session.id,
      wsBorsh.AGENT_EVENT_CREDENTIAL_WARNING,
      { messageId: record.id, types },
      0
    );
    void this.pushCredentialWarning(session, types);
  }

  private async pushCredentialWarning(session: AgentSessionRecord, types: string[]): Promise<void> {
    try {
      const settings = getSiteSettings();
      if (!settings.enableNotificationPush) {
        return;
      }
      const text = t('telegram.agentCredentialWarning', {
        siteName: settings.siteName,
        sessionTitle: session.title,
        types: types.join(', '),
      });
      await telegramService.sendToAuthorizedChats({ text });
    } catch (error) {
      console.error('[agent-supervisor] credential warning push failed:', error);
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = getAgentSessionById(sessionId);
    if (!session) {
      throw new AgentSessionNotFoundError();
    }

    this.suppressResume(sessionId);
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.run.requestStop('manual');
      await active.promise;
      return;
    }

    // 无活动 run：取消 pending confirmations 并补 denied responses，防止消息流悬空
    if (this.cancelPendingConfirmations(sessionId, 'stopped by user') > 0) {
      this.appendApprovalResponsesIfReady(sessionId);
    }

    updateAgentSession(sessionId, { status: 'stopped', lastError: null });
    this.deps.hub.broadcastAgentEvent(
      sessionId,
      wsBorsh.AGENT_EVENT_STATUS,
      { status: 'stopped', lastError: null },
      0
    );
  }

  /**
   * 设备连接关闭时主动停止绑定该设备的 session：
   * - 所有仍在 activeRuns 且绑定该设备的 entry（不看 DB status）一律 suppressResume + requestStop
   *   （run 可能已落 idle/error 但仍卡在 finally/release）；
   * - DB 为 running/waiting_confirmation 且无活动 run 的直接落 error。
   */
  stopSessionsForDevice(deviceId: string, reason: AgentStopReason = 'pane_lost'): void {
    this.lostDeviceIds.add(deviceId);
    for (const [sessionId, entry] of this.activeRuns) {
      const boundDeviceId = entry.deviceId ?? getAgentSessionById(sessionId)?.deviceId ?? null;
      if (boundDeviceId !== deviceId) {
        continue;
      }
      this.suppressResume(sessionId);
      entry.run.requestStop(reason);
    }

    const sessions = [
      ...getAgentSessionsByStatus('running'),
      ...getAgentSessionsByStatus('waiting_confirmation'),
    ].filter((s) => s.deviceId === deviceId);

    for (const session of sessions) {
      this.suppressResume(session.id);
      if (this.activeRuns.has(session.id)) {
        continue;
      }
      const message = 'terminal connection lost: pane/device unavailable';
      updateAgentSession(session.id, { status: 'error', lastError: message });
      this.deps.hub.broadcastAgentEvent(
        session.id,
        wsBorsh.AGENT_EVENT_STATUS,
        { status: 'error', lastError: message },
        0
      );
    }
  }

  resolveConfirmation(
    confirmationId: string,
    approved: boolean,
    reason?: string
  ): AgentConfirmationRecord {
    const confirmation = getAgentConfirmationById(confirmationId);
    if (!confirmation) {
      throw new AgentConfirmationNotFoundError();
    }

    const sessionId = confirmation.sessionId;
    const decided = decideAgentConfirmation(confirmationId, {
      status: approved ? 'approved' : 'denied',
      reason: reason ?? null,
    });
    if (!decided) {
      throw new AgentConfirmationAlreadyDecidedError();
    }

    this.deps.hub.broadcastAgentEvent(
      sessionId,
      wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED,
      {
        confirmationId: decided.id,
        status: approved ? 'approved' : 'denied',
        reason: decided.reason,
      },
      0
    );

    // 等同一回合全部确认决定后合并落库一条 tool-approval-response 消息并续跑
    if (
      !this.activeRuns.has(sessionId) &&
      listPendingAgentConfirmations(sessionId).length === 0 &&
      this.appendApprovalResponsesIfReady(sessionId)
    ) {
      this.startRun(sessionId);
    }

    return decided;
  }

  /** 将 session 残留的 pending confirmations 置为 cancelled 并广播，返回处理条数 */
  private cancelPendingConfirmations(sessionId: string, reason: string): number {
    const pending = listPendingAgentConfirmations(sessionId);
    for (const confirmation of pending) {
      const decided = decideAgentConfirmation(confirmation.id, {
        status: 'cancelled',
        reason,
      });
      if (decided) {
        this.deps.hub.broadcastAgentEvent(
          sessionId,
          wsBorsh.AGENT_EVENT_CONFIRMATION_RESOLVED,
          {
            confirmationId: decided.id,
            status: 'cancelled',
            reason: decided.reason,
          },
          0
        );
      }
    }
    return pending.length;
  }

  private suppressResume(sessionId: string): void {
    this.resumeSuppressedSessionIds.add(sessionId);
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.resumeSuppressed = true;
    }
  }

  private startRun(sessionId: string): void {
    if (this.stopping || this.activeRuns.has(sessionId)) {
      return;
    }

    this.resumeSuppressedSessionIds.delete(sessionId);
    const deviceId = getAgentSessionById(sessionId)?.deviceId ?? null;
    if (deviceId) {
      this.lostDeviceIds.delete(deviceId);
    }
    const run = this.deps.createRun(sessionId);
    const entry: ActiveRun = {
      run,
      promise: Promise.resolve(),
      stale: false,
      resumeSuppressed: false,
      deviceId,
    };
    entry.promise = run
      .execute()
      .catch((error) => {
        console.error(`[agent-supervisor] run for session ${sessionId} crashed:`, error);
      })
      .finally(() => {
        if (this.activeRuns.get(sessionId) === entry) {
          this.activeRuns.delete(sessionId);
        }
        if (entry.stale) {
          this.resumeSessionIfNeeded(sessionId);
        } else if (entry.resumeSuppressed) {
          this.resumeSuppressedSessionIds.delete(sessionId);
        }
      });
    this.activeRuns.set(sessionId, entry);
  }

  private resumeSessionIfNeeded(sessionId: string): void {
    if (this.stopping || !this.started) {
      return;
    }
    this.staleSessionIds.delete(sessionId);
    const active = this.activeRuns.get(sessionId);
    if (active?.resumeSuppressed || this.resumeSuppressedSessionIds.has(sessionId)) {
      this.resumeSuppressedSessionIds.delete(sessionId);
      return;
    }
    if (this.activeRuns.has(sessionId)) {
      return;
    }
    const session = getAgentSessionById(sessionId);
    if (!session || isSessionOrphan(session)) {
      return;
    }
    if (session.deviceId && this.lostDeviceIds.has(session.deviceId)) {
      return;
    }
    if (session.status === 'stopped') {
      return;
    }
    if (session.status !== 'running' && listQueuedAgentMessages(sessionId).length === 0) {
      return;
    }
    this.startRun(sessionId);
  }

  /**
   * 检查最后一条 assistant 消息中的 tool-approval-request 是否均已有响应；
   * 缺失的根据 confirmations 决议合并落库一条 tool 消息。
   * - approved/denied → tool-approval-response part（AI SDK 续跑时从最后一条 tool 消息消费）
   * - cancelled → 合成 execution-denied tool-result part（不续跑也能保证消息流完整，
   *   否则 approval-response 一旦不在最后一条消息就永远不会被消费，tool call 悬空会导致
   *   provider 拒绝后续请求）
   * 返回 true 表示消息流完整、可发起续跑；存在 pending 或找不到 approval-request 时返回 false。
   */
  private appendApprovalResponsesIfReady(sessionId: string): boolean {
    const inspected = inspectApprovalMessages(listAgentMessages(sessionId));
    if (!inspected) {
      return false;
    }

    const confirmations = new Map<string, ApprovalConfirmationLike | null>(
      inspected.requests.map((request) => [
        request.approvalId,
        getAgentConfirmationById(request.approvalId),
      ])
    );
    const plan = buildApprovalResponsePlan(inspected, confirmations);
    if (plan.kind === 'not-ready') {
      return false;
    }
    if (plan.kind === 'already-ready') {
      return true;
    }

    const record = appendAgentMessage(sessionId, 'tool', { role: 'tool', content: plan.parts });
    this.broadcastPersisted(sessionId, record);
    return true;
  }

  private broadcastPersisted(sessionId: string, record: AgentMessageRecord): void {
    this.deps.hub.broadcastAgentEvent(
      sessionId,
      wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED,
      {
        messageId: record.id,
        seq: record.seq,
        role: record.role,
      },
      0
    );
  }
}

export const agentSupervisor = new AgentSupervisor();
