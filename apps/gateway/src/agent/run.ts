// Agent 单轮 run 执行器
// 一次 run = 一次 streamText 多步循环（直到 stepCountIs / 等待审批 / abort / 出错）。
// 只在 step 边界落库完整 ModelMessage；流式 delta 仅聚合节流广播，不持久化。

import { type AgentEventPayloadMap, type EventType, wsBorsh } from '@tmex/shared';
import { type LanguageModel, type ModelMessage, streamText } from 'ai';
import { getDeviceById } from '../db';
import {
  type AgentMessageRole,
  type AgentSessionRecord,
  appendAgentMessage,
  getAgentSessionById,
  getMaxAgentMessageSeq,
  listAgentMessages,
  updateAgentSession,
} from '../db/agent';
import { t } from '../i18n';
import type { PaneEmulator } from '../tmux-client/pane-emulator';
import { type BuiltRunRequest, buildRunRequest, buildRunTools } from './build-run-request';
import {
  type AgentStopReason,
  type RunOnceDecision,
  resolveRunOnceOutcome,
} from './outcome-resolver';
import { decideRunRetry, toErrorMessage } from './retry-policy';
import { type AgentRunDeps, defaultAgentRunDeps } from './run-deps';
import {
  type AgentRunOutcome,
  type RunFinishSink,
  finishAbortedRun,
  finishErrorRun,
  finishIdleRun,
  finishWaitingConfirmationRun,
} from './run-finish';
import { notifyAgentEvent } from './run-notify';
import {
  acquireRunResources,
  releaseHeldPaneEmulator,
  releaseRunResources,
} from './run-resource-scope';
import { type PendingApproval, createRunStreamHandlers } from './run-stream-handlers';
import { RunWatchdog } from './run-watchdog';
import { StepMessagePersister } from './step-persister';
import { StreamAccumulator } from './stream-accumulator';
import { consumeAgentStream } from './stream-part-router';
import { maybeGenerateSessionTitle } from './title-generation';
import type { TerminalRuntimeLike } from './tools/terminal';

export type { AgentStopReason } from './outcome-resolver';
export type { AgentRunDeps } from './run-deps';
export type { AgentRunOutcome } from './run-finish';
export { MESSAGE_WINDOW_CHAR_BUDGET, applyMessageWindow } from './build-run-request';
export { isRetryableLlmError } from './retry-policy';

const TERMINAL_FAILURE_LIMIT = 2;
type RunOnceResult = AgentRunOutcome | 'steer';

export class AgentRun {
  readonly sessionId: string;

  private readonly deps: AgentRunDeps;
  private readonly deltas: StreamAccumulator;
  private abortController = new AbortController();
  private stopReason: AgentStopReason | null = null;
  private steerRequested = false;
  private terminalFailureStreak = 0;
  private terminalFatal = false;
  private terminalFatalMessage = '';
  private stalled = false;
  private emulator: PaneEmulator | null = null;
  private runtimeDeviceId: string | null = null;
  private runtimePaneId: string | null = null;
  private eventSeq = 0;

  constructor(sessionId: string, deps: Partial<AgentRunDeps> = {}) {
    this.sessionId = sessionId;
    this.deps = { ...defaultAgentRunDeps, ...deps };
    this.deltas = new StreamAccumulator(
      {
        emitText: (messageId, delta) => {
          this.broadcast(wsBorsh.AGENT_EVENT_TEXT_DELTA, { messageId, delta });
        },
        emitReasoning: (messageId, delta) => {
          this.broadcast(wsBorsh.AGENT_EVENT_REASONING_DELTA, { messageId, delta });
        },
      },
      {
        flushIntervalMs: this.deps.deltaFlushIntervalMs,
        flushMaxBytes: this.deps.deltaFlushMaxBytes,
      }
    );
  }

  get inProgressText(): string {
    return this.deltas.inProgressText;
  }
  get inProgressReasoning(): string {
    return this.deltas.inProgressReasoning;
  }
  requestStop(reason: AgentStopReason): void {
    if (this.stopReason && this.stopReason !== 'shutdown') {
      return;
    }
    this.stopReason = reason;
    this.abortController.abort();
  }

  requestSteer(): void {
    if (this.stopReason) {
      return;
    }
    this.steerRequested = true;
    this.abortController.abort();
  }

  async execute(): Promise<AgentRunOutcome> {
    const session = getAgentSessionById(this.sessionId);
    if (!session) {
      return 'error';
    }
    this.setStatus('running');

    let runtime: TerminalRuntimeLike | null = null;
    const runtimeDeviceId = session.deviceId;
    this.runtimeDeviceId = runtimeDeviceId;
    this.runtimePaneId = session.paneId;
    try {
      const acquired = await acquireRunResources({
        deviceId: runtimeDeviceId,
        paneId: session.paneId,
        acquireRuntime: this.deps.acquireRuntime,
      });
      if (acquired.runtimeError) {
        return finishErrorRun(this.finishSink(), session, acquired.runtimeError);
      }
      runtime = acquired.runtime;
      this.emulator = acquired.emulator;
      return await this.runLoop(session, runtime);
    } finally {
      this.deltas.clearTimer();
      const emulator = this.emulator;
      this.emulator = null;
      await releaseRunResources({
        emulator,
        runtime,
        deviceId: runtimeDeviceId,
        paneId: session.paneId,
        releaseRuntime: this.deps.releaseRuntime,
      });
      this.runtimeDeviceId = null;
      this.runtimePaneId = null;
    }
  }

  private async runLoop(
    session: AgentSessionRecord,
    runtime: TerminalRuntimeLike | null
  ): Promise<AgentRunOutcome> {
    let attempt = 0;
    while (true) {
      if (this.stopReason) {
        return finishAbortedRun(this.finishSink(), session);
      }
      this.abortController = new AbortController();
      this.steerRequested = false;
      this.stalled = false;
      try {
        const result = await this.runOnce(session, runtime);
        if (result !== 'steer') {
          return result;
        }
        attempt = 0;
        this.persistDrainedQueue();
      } catch (error) {
        this.deltas.clearTimer();
        const decision = decideRunRetry({
          aborted: Boolean(this.stopReason || this.abortController.signal.aborted),
          attempt,
          retryDelaysMs: this.deps.retryDelaysMs,
          error,
        });
        if (decision.action === 'aborted') {
          return finishAbortedRun(this.finishSink(), session);
        }
        if (decision.action === 'retry') {
          attempt += 1;
          console.error(
            `[agent-run] session ${this.sessionId} attempt ${attempt} failed, retrying in ${decision.delayMs}ms:`,
            error
          );
          await this.deps.sleepMs(decision.delayMs);
          continue;
        }
        return finishErrorRun(this.finishSink(), session, toErrorMessage(error));
      }
    }
  }

  private async runOnce(
    session: AgentSessionRecord,
    runtime: TerminalRuntimeLike | null
  ): Promise<RunOnceResult> {
    const request = await this.assembleRunRequest(session, runtime);
    this.deltas.reset();
    const approvals: PendingApproval[] = [];
    let streamError: unknown = null;
    let aborted = false;
    const persister = new StepMessagePersister((message: { role: string }) => {
      const record = appendAgentMessage(
        this.sessionId,
        message.role as AgentMessageRole,
        message as unknown as ModelMessage
      );
      this.broadcast(wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED, {
        messageId: record.id,
        seq: record.seq,
        role: record.role,
      });
    });
    await consumeAgentStream(
      this.openRunStream(request, persister, runtime).fullStream,
      createRunStreamHandlers({
        deltas: this.deltas,
        broadcast: (eventType, payload) => this.broadcast(eventType, payload),
        approvals,
        onError: (error) => {
          streamError = error;
        },
        onAbort: () => {
          aborted = true;
        },
      }),
      new RunWatchdog({
        timeoutMs: this.deps.streamIdleTimeoutMs,
        onStall: () => {
          this.stalled = true;
          this.abortController.abort();
        },
      })
    );
    this.deltas.flush();
    return this.fulfillRunOnceDecision(
      session,
      resolveRunOnceOutcome({
        stalled: this.stalled,
        stopReason: this.stopReason,
        steerRequested: this.steerRequested,
        aborted: aborted || this.abortController.signal.aborted,
        streamError,
        hasApprovals: approvals.length > 0,
        hasQueuedMessages: this.deps.hasQueuedMessages(this.sessionId),
        terminalFatal: this.terminalFatal,
        terminalFatalMessage: this.terminalFatalMessage,
      }),
      approvals,
      request.model
    );
  }

  private async assembleRunRequest(
    session: AgentSessionRecord,
    runtime: TerminalRuntimeLike | null
  ): Promise<BuiltRunRequest> {
    const resolvedModel = await this.deps.resolveModel(session.providerId, session.modelId);
    const tools = await buildRunTools({
      paneId: session.paneId,
      deviceId: session.deviceId,
      writeMode: session.writeMode,
      allowControlChars: session.allowControlChars,
      useProviderWebSearch: session.useProviderWebSearch,
      providerId: session.providerId,
      providerHostedTools: session.providerHostedTools,
      runtime,
      getEmulator: () => this.emulator,
      onFailure: () => this.recordTerminalFailure(),
      onSuccess: () => {
        this.terminalFailureStreak = 0;
      },
      sleepMs: this.deps.sleepMs,
      resolveProviderWebSearchTool: this.deps.resolveProviderWebSearchTool,
      resolveProviderHostedTools: this.deps.resolveProviderHostedTools,
      createWebSearchTool: this.deps.createWebSearchTool,
      createFetchUrlTool: this.deps.createFetchUrlTool,
    });
    return buildRunRequest({
      messages: listAgentMessages(this.sessionId).map((record) => record.content as ModelMessage),
      resolvedModel,
      tools,
      paneId: session.paneId,
      writeMode: session.writeMode,
      customSystemPrompt: session.systemPrompt,
      maxStepsPerTurn: session.maxStepsPerTurn,
      device: session.deviceId ? getDeviceById(session.deviceId) : null,
    });
  }

  private openRunStream(
    request: BuiltRunRequest,
    persister: StepMessagePersister,
    runtime: TerminalRuntimeLike | null
  ) {
    return streamText({
      ...request,
      abortSignal: this.abortController.signal,
      maxRetries: this.deps.llmMaxRetries,
      onError: ({ error }) => {
        console.error(`[agent-run] streamText error for ${this.sessionId}:`, error);
      },
      onStepFinish: (step) => {
        persister.persistNewMessages(step.response.messages);
        this.deltas.flush();
        this.deltas.clearInProgress();
        this.handleStepBoundary(runtime);
      },
    });
  }

  private handleStepBoundary(runtime: TerminalRuntimeLike | null): void {
    if (!this.steerRequested && !this.stopReason && this.deps.hasQueuedMessages(this.sessionId)) {
      this.steerRequested = true;
      this.abortController.abort();
    }
    if (runtime?.isTerminated) {
      this.terminalFatal = true;
      this.terminalFatalMessage = 'terminal connection lost during run';
      this.abortController.abort();
    }
  }

  private persistDrainedQueue(): void {
    for (const text of this.deps.drainQueuedMessages(this.sessionId)) {
      const record = appendAgentMessage(this.sessionId, 'user', { role: 'user', content: text });
      this.broadcast(wsBorsh.AGENT_EVENT_MESSAGE_PERSISTED, {
        messageId: record.id,
        seq: record.seq,
        role: record.role,
      });
    }
  }

  private async fulfillRunOnceDecision(
    session: AgentSessionRecord,
    decision: RunOnceDecision,
    approvals: PendingApproval[],
    model: LanguageModel
  ): Promise<RunOnceResult> {
    const sink = this.finishSink();
    switch (decision.kind) {
      case 'stalled-error':
        return finishErrorRun(sink, session, t('agent.error.streamStalled'));
      case 'fatal-error':
      case 'pane-lost-error':
      case 'interrupted':
      case 'stopped':
        return finishAbortedRun(sink, session);
      case 'steer':
        return 'steer';
      case 'throw': {
        const error = decision.error;
        throw error instanceof Error ? error : new Error(String(error));
      }
      case 'waiting-confirmation':
        return finishWaitingConfirmationRun(sink, session, approvals);
      case 'idle':
        await this.maybeGenerateTitle(session, model);
        return finishIdleRun(sink, session, this.deps.notifyTurnFinished);
    }
  }

  private finishSink(): RunFinishSink {
    return {
      sessionId: this.sessionId,
      terminalFatal: this.terminalFatal,
      terminalFatalMessage: this.terminalFatalMessage,
      stopReason: this.stopReason,
      clearTimer: () => this.deltas.clearTimer(),
      consumeInProgressText: () => this.deltas.consumeInProgressText(),
      lastMessageSeq: () => getMaxAgentMessageSeq(this.sessionId),
      setStatus: (status, lastError) => this.setStatus(status, lastError),
      broadcast: (eventType, payload) => this.broadcast(eventType, payload),
      notify: (eventType, session, payload) => void this.safeNotify(eventType, session, payload),
    };
  }

  private recordTerminalFailure(): void {
    this.terminalFailureStreak += 1;
    if (this.terminalFailureStreak >= TERMINAL_FAILURE_LIMIT && !this.terminalFatal) {
      this.terminalFatal = true;
      this.terminalFatalMessage = `terminal tool failed ${this.terminalFailureStreak} times in a row, aborting run`;
      if (this.emulator && this.runtimeDeviceId && this.runtimePaneId) {
        const deviceId = this.runtimeDeviceId;
        const paneId = this.runtimePaneId;
        this.emulator = null;
        void releaseHeldPaneEmulator({ deviceId, paneId }).catch((error) => {
          console.error('[agent-run] failed to release emulator on fatal:', error);
        });
      }
      this.abortController.abort();
    }
  }

  private async maybeGenerateTitle(
    session: AgentSessionRecord,
    model: LanguageModel
  ): Promise<void> {
    await maybeGenerateSessionTitle({
      currentTitle: session.title,
      messages: listAgentMessages(this.sessionId),
      generate: (prompt) => this.deps.generateTitle(model, prompt),
      sessionId: this.sessionId,
      apply: (title) => {
        updateAgentSession(this.sessionId, { title });
        session.title = title;
        const latest = getAgentSessionById(this.sessionId);
        if (latest) {
          this.broadcast(wsBorsh.AGENT_EVENT_STATUS, {
            status: latest.status,
            lastError: latest.lastError,
          });
        }
      },
    });
  }

  private nextSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }
  private broadcast<K extends keyof AgentEventPayloadMap>(
    eventType: K,
    payload: AgentEventPayloadMap[K]
  ): void {
    try {
      this.deps.broadcast(this.sessionId, eventType, payload, this.nextSeq());
    } catch (error) {
      console.error(`[agent-run] broadcast failed for ${this.sessionId}:`, error);
    }
  }

  private setStatus(status: AgentSessionRecord['status'], lastError: string | null = null): void {
    updateAgentSession(this.sessionId, { status, lastError });
    this.broadcast(wsBorsh.AGENT_EVENT_STATUS, { status, lastError });
  }

  private async safeNotify(
    eventType: EventType,
    session: AgentSessionRecord,
    payload: Record<string, unknown>
  ): Promise<void> {
    await notifyAgentEvent({ notify: this.deps.notify, session, eventType, payload });
  }
}
