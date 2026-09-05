import type {
  EventType,
  WatchEventPayloadMap,
  WatchRuleSampleDto,
  WebhookEvent,
} from '@tmex/shared';
import { errorMessage } from '@tmex/shared';
import type { LanguageModel } from 'ai';
import { agentWsHub } from '../agent/ws-hub';
import { getDeviceById, getSiteSettings } from '../db';
import {
  type WatchRuleRecord,
  type WatchRuleStateRecord,
  deleteWatchRule,
  getEnabledWatchRules,
  getWatchRuleById,
  getWatchRuleState,
  updateWatchRule,
  writeWatchRuleState,
} from '../db/watch';
import { eventNotifier } from '../events';
import { resolveLanguageModel } from '../llm/provider-registry';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { isTargetMissingMessage } from '../tmux-client/target-missing';
import {
  type WatchLlmCallerDeps,
  callConfirm,
  callJudge,
  callSummary,
  passesLlmCooldownGate,
} from './evaluation-pipeline';
import { type WatchEvalOutput, evaluateWatchRule } from './evaluator';
import { WatchNotifier } from './notifier';
import { type WatchRuntimeLike, WatchRuntimePool } from './runtime-pool';
import { WatchSampleStore } from './sample-store';
import { WatchRuleScheduler, effectiveIntervalSeconds } from './scheduler';

export type { WatchRuntimeLike };
export { effectiveIntervalSeconds };

export interface WatchServiceDeps {
  listEnabledRules: () => WatchRuleRecord[];
  getRule: (id: string) => WatchRuleRecord | null;
  getState: (id: string) => WatchRuleStateRecord | null;
  upsertState: (id: string, updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>>) => void;
  updateRule: (
    id: string,
    updates: Partial<Omit<WatchRuleRecord, 'id' | 'createdAt' | 'updatedAt'>>
  ) => WatchRuleRecord | null;
  deleteRule: (id: string) => void;
  acquireRuntime: (deviceId: string) => Promise<WatchRuntimeLike>;
  releaseRuntime: (deviceId: string, runtime?: WatchRuntimeLike) => Promise<void>;
  resolveModel: (providerId: string | null, modelId: string | null) => Promise<LanguageModel>;
  notify: (
    eventType: EventType,
    event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
  ) => Promise<void>;
  broadcast: <K extends keyof WatchEventPayloadMap>(
    ruleId: string,
    deviceId: string,
    paneId: string,
    eventType: K,
    payload: WatchEventPayloadMap[K]
  ) => void;
  getDevice: typeof getDeviceById;
  getSettings: typeof getSiteSettings;
  now: () => Date;
  monotonicNow?: () => number;
  scheduleInterval: (fn: () => void, ms: number) => () => void;
  errorThreshold: number;
  llmMaxRetries: number;
}

const defaultDeps: WatchServiceDeps = {
  listEnabledRules: getEnabledWatchRules,
  getRule: getWatchRuleById,
  getState: getWatchRuleState,
  upsertState: writeWatchRuleState,
  updateRule: updateWatchRule,
  deleteRule: deleteWatchRule,
  acquireRuntime: (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  releaseRuntime: (deviceId, runtime) => tmuxRuntimeRegistry.release(deviceId, runtime),
  resolveModel: resolveLanguageModel,
  notify: (eventType, event) => eventNotifier.notify(eventType, event),
  broadcast: (ruleId, deviceId, paneId, eventType, payload) =>
    agentWsHub.broadcastWatchEvent(ruleId, deviceId, paneId, eventType, payload),
  getDevice: getDeviceById,
  getSettings: getSiteSettings,
  now: () => new Date(),
  scheduleInterval: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  errorThreshold: 10,
  llmMaxRetries: 2,
};

export class WatchService {
  private readonly deps: WatchServiceDeps;
  private readonly scheduler: WatchRuleScheduler;
  private readonly runtimePool: WatchRuntimePool;
  private readonly samples = new WatchSampleStore();
  private readonly notifier: WatchNotifier;
  private readonly llm: WatchLlmCallerDeps;
  private started = false;

  constructor(deps: Partial<WatchServiceDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
    this.scheduler = new WatchRuleScheduler(
      this.deps.monotonicNow ? { now: this.deps.monotonicNow } : {}
    );
    this.runtimePool = new WatchRuntimePool({
      acquireRuntime: this.deps.acquireRuntime,
      releaseRuntime: this.deps.releaseRuntime,
    });
    this.notifier = new WatchNotifier({
      notify: this.deps.notify,
      broadcast: this.deps.broadcast,
      getDevice: this.deps.getDevice,
      getSettings: this.deps.getSettings,
      getSnapshot: (deviceId) => this.runtimePool.lastSnapshot(deviceId),
    });
    this.llm = {
      resolveModel: this.deps.resolveModel,
      llmMaxRetries: this.deps.llmMaxRetries,
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const rule of this.deps.listEnabledRules()) {
      this.addRule(rule);
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const releases: Array<Promise<void>> = [];
    for (const ruleId of this.scheduler.ruleIds()) {
      releases.push(this.teardownRuleAndWait(ruleId));
    }
    await Promise.all(releases);
    this.samples.clear();
  }

  async refreshRule(ruleId: string): Promise<void> {
    await this.teardownRuleAndWait(ruleId);
    if (!this.started) {
      return;
    }
    const rule = this.deps.getRule(ruleId);
    if (rule?.enabled) {
      this.addRule(rule);
    }
  }

  async removeRule(ruleId: string): Promise<void> {
    await this.teardownRuleAndWait(ruleId);
    this.samples.delete(ruleId);
  }

  isRuleScheduled(ruleId: string): boolean {
    return this.scheduler.has(ruleId);
  }

  getSamples(ruleId: string): WatchRuleSampleDto[] {
    return this.samples.get(ruleId);
  }

  async tickRule(ruleId: string): Promise<void> {
    return this.scheduler.runExclusive(ruleId, () => this.runTick(ruleId));
  }

  async tickPane(deviceId: string, paneId: string): Promise<void> {
    return this.scheduler.runPaneExclusive(deviceId, paneId, () =>
      this.runPaneTick(deviceId, paneId)
    );
  }

  private addRule(rule: WatchRuleRecord): void {
    const added = this.scheduler.add(
      rule,
      (deviceId, paneId) => void this.tickPane(deviceId, paneId),
      this.deps.scheduleInterval
    );
    if (!added) {
      return;
    }
    this.runtimePool.addRule(rule.deviceId, rule.id);
  }

  private async teardownRule(ruleId: string): Promise<void> {
    const entry = this.scheduler.detach(ruleId);
    if (!entry) {
      return;
    }
    await this.runtimePool.removeRule(entry.deviceId, ruleId);
  }

  private async teardownRuleAndWait(ruleId: string): Promise<void> {
    const entry = this.scheduler.detach(ruleId);
    if (!entry) {
      return;
    }
    await this.scheduler.waitForTick(entry);
    await this.runtimePool.removeRule(entry.deviceId, ruleId);
  }

  private async runTick(ruleId: string): Promise<void> {
    const captured = await this.captureForRule(ruleId);
    if (!captured) {
      return;
    }
    await this.evaluateCaptured(captured.rule, captured.screen, captured.now);
  }

  private async runPaneTick(deviceId: string, paneId: string): Promise<void> {
    const dueIds = this.scheduler.takeDueRuleIds(deviceId, paneId);
    if (dueIds.length === 0) {
      return;
    }
    const device = this.runtimePool.get(deviceId);
    if (!device) {
      return;
    }

    const now = this.deps.now();
    let screen: string;
    try {
      const runtime = await this.runtimePool.ensureRuntime(device);
      screen = await runtime.capturePaneText(paneId);
    } catch (error) {
      for (const ruleId of dueIds) {
        await this.handleCaptureFailure(ruleId, error, now);
      }
      return;
    }

    for (const ruleId of dueIds) {
      if (!this.scheduler.has(ruleId)) {
        continue;
      }
      await this.scheduler.runExclusive(ruleId, async () => {
        const rule = this.deps.getRule(ruleId);
        if (!rule || !rule.enabled) {
          await this.teardownRule(ruleId);
          return;
        }
        await this.evaluateCaptured(rule, screen, now);
      });
    }
  }

  private async captureForRule(
    ruleId: string
  ): Promise<{ rule: WatchRuleRecord; screen: string; now: Date } | null> {
    const rule = this.deps.getRule(ruleId);
    if (!rule || !rule.enabled) {
      await this.teardownRule(ruleId);
      return null;
    }

    const device = this.runtimePool.get(rule.deviceId);
    if (!device) {
      return null;
    }

    const now = this.deps.now();
    try {
      const runtime = await this.runtimePool.ensureRuntime(device);
      const screen = await runtime.capturePaneText(rule.paneId);
      if (!this.scheduler.has(rule.id)) {
        return null;
      }
      return { rule, screen, now };
    } catch (error) {
      await this.handleCaptureFailure(ruleId, error, now, rule);
      return null;
    }
  }

  private async handleCaptureFailure(
    ruleId: string,
    error: unknown,
    now: Date,
    knownRule?: WatchRuleRecord
  ): Promise<void> {
    if (!this.scheduler.has(ruleId)) {
      return;
    }
    const rule = knownRule ?? this.deps.getRule(ruleId);
    if (!rule) {
      return;
    }
    const message = errorMessage(error);
    if (isTargetMissingMessage(message)) {
      await this.handlePaneGone(rule);
      return;
    }
    await this.recordRuleError(rule, message, now);
  }

  private async evaluateCaptured(rule: WatchRuleRecord, screen: string, now: Date): Promise<void> {
    if (!this.scheduler.has(rule.id)) {
      return;
    }
    const state = this.deps.getState(rule.id);
    if (rule.triggerType === 'llm') {
      await this.processLlmRule(rule, state, screen, now);
    } else {
      await this.processRegexRule(rule, state, screen, now);
    }
  }

  private async processRegexRule(
    rule: WatchRuleRecord,
    state: WatchRuleStateRecord | null,
    screen: string,
    now: Date
  ): Promise<void> {
    const output = evaluateWatchRule({ screen, rule, state, now });
    if (output.error) {
      await this.recordRuleError(rule, output.error, now);
      return;
    }

    const updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>> = {
      lastSampledAt: now.toISOString(),
      consecutiveErrors: 0,
      lastError: null,
      ...output.stateUpdates,
    };

    let fired = false;
    if (output.hit) {
      fired = await this.fireRegexTrigger(rule, state, output, screen, now, updates);
    }

    if (!this.scheduler.has(rule.id)) {
      return;
    }
    this.deps.upsertState(rule.id, updates);
    this.samples.push(rule.id, now, output.value ?? output.matchedText ?? null, fired);

    if (fired && rule.fireMode === 'once' && rule.triggerType === 'match') {
      this.deps.updateRule(rule.id, { enabled: false });
      await this.teardownRule(rule.id);
    }
  }

  private async fireRegexTrigger(
    rule: WatchRuleRecord,
    state: WatchRuleStateRecord | null,
    output: WatchEvalOutput,
    screen: string,
    now: Date,
    updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>>
  ): Promise<boolean> {
    let notified = state?.modelUnavailableNotified ?? false;
    let unconfirmed = false;

    if (rule.confirmWithLlm) {
      try {
        const result = await callConfirm(this.llm, rule, output, screen);
        notified = false;
        updates.modelUnavailableNotified = notified;
        if (!result.confirmed) {
          return false;
        }
      } catch (error) {
        unconfirmed = true;
        notified = await this.notifier.raiseModelUnavailable(rule, notified, error);
        updates.modelUnavailableNotified = notified;
      }
    }

    let summary: string | null = null;
    if (rule.summarizeWithLlm) {
      try {
        summary = (await callSummary(this.llm, rule, output, screen)).summary;
        notified = false;
        updates.modelUnavailableNotified = notified;
      } catch (error) {
        notified = await this.notifier.raiseModelUnavailable(rule, notified, error);
        updates.modelUnavailableNotified = notified;
      }
    }

    if (!this.scheduler.has(rule.id)) {
      return false;
    }
    await this.notifier.emitTrigger(rule, output, summary, unconfirmed);
    updates.lastTriggeredAt = now.toISOString();
    if (rule.triggerType === 'unchanged') {
      updates.triggeredSinceChange = true;
    }
    return true;
  }

  private async processLlmRule(
    rule: WatchRuleRecord,
    state: WatchRuleStateRecord | null,
    screen: string,
    now: Date
  ): Promise<void> {
    const updates: Partial<Omit<WatchRuleStateRecord, 'ruleId'>> = {
      lastSampledAt: now.toISOString(),
    };
    let notified = state?.modelUnavailableNotified ?? false;

    let matched = false;
    let reason = '';
    try {
      const result = await callJudge(this.llm, rule, screen);
      if (!this.scheduler.has(rule.id)) {
        return;
      }
      matched = result.matched;
      reason = result.reason;
      notified = false;
      updates.modelUnavailableNotified = notified;
      updates.consecutiveErrors = 0;
      updates.lastError = null;
    } catch (error) {
      if (!this.scheduler.has(rule.id)) {
        return;
      }
      const message = errorMessage(error);
      notified = await this.notifier.raiseModelUnavailable(rule, notified, error);
      updates.modelUnavailableNotified = notified;
      const errors = (state?.consecutiveErrors ?? 0) + 1;
      updates.consecutiveErrors = errors;
      updates.lastError = message;
      this.deps.upsertState(rule.id, updates);
      this.samples.push(rule.id, now, null, false);
      if (errors >= this.deps.errorThreshold) {
        await this.disableRuleForErrors(rule, errors, message);
      }
      return;
    }

    let fired = false;
    if (matched && passesLlmCooldownGate(rule, state, now)) {
      const output: WatchEvalOutput = { hit: true, stateUpdates: {} };
      await this.notifier.emitTrigger(rule, output, null, false, reason);
      updates.lastTriggeredAt = now.toISOString();
      fired = true;
    }

    if (!this.scheduler.has(rule.id)) {
      return;
    }
    this.deps.upsertState(rule.id, updates);
    this.samples.push(rule.id, now, matched ? reason || 'matched' : null, fired);

    if (fired && rule.fireMode === 'once') {
      this.deps.updateRule(rule.id, { enabled: false });
      await this.teardownRule(rule.id);
    }
  }

  private async recordRuleError(rule: WatchRuleRecord, message: string, now: Date): Promise<void> {
    const state = this.deps.getState(rule.id);
    const errors = (state?.consecutiveErrors ?? 0) + 1;
    this.deps.upsertState(rule.id, {
      lastSampledAt: now.toISOString(),
      consecutiveErrors: errors,
      lastError: message,
    });
    this.samples.push(rule.id, now, null, false);
    if (errors >= this.deps.errorThreshold) {
      await this.disableRuleForErrors(rule, errors, message);
    }
  }

  private async handlePaneGone(rule: WatchRuleRecord): Promise<void> {
    this.deps.deleteRule(rule.id);
    await this.teardownRule(rule.id);
    this.samples.delete(rule.id);
    await this.notifier.notifyPaneGone(rule);
  }

  private async disableRuleForErrors(
    rule: WatchRuleRecord,
    errorCount: number,
    detail: string
  ): Promise<void> {
    this.deps.updateRule(rule.id, { enabled: false });
    await this.teardownRule(rule.id);
    await this.notifier.notifyRuleError(rule, errorCount, detail);
  }
}

export const watchService = new WatchService();
