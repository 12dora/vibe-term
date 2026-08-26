import type {
  EventType,
  StateSnapshotPayload,
  WatchEventPayloadMap,
  WebhookEvent,
} from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { getDeviceById, getSiteSettings } from '../db';
import type { WatchRuleRecord } from '../db/watch';
import { t } from '../i18n';
import { type PaneLocationContext, resolvePaneContext } from '../tmux/bell-context';
import type { WatchEvalOutput } from './evaluator';

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WatchNotifierDeps {
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
  getSnapshot: (deviceId: string) => StateSnapshotPayload | null;
}

export function buildTriggerMessage(
  rule: WatchRuleRecord,
  output: WatchEvalOutput,
  summary: string | null,
  unconfirmed: boolean,
  llmReason?: string
): string {
  let base: string;
  if (summary) {
    base = t('notification.watch.summaryTriggered', { name: rule.name, summary });
  } else if (rule.triggerType === 'unchanged') {
    base = t('notification.watch.unchangedTriggered', {
      name: rule.name,
      value: output.value ?? '',
      minutes: output.stuckMinutes ?? 0,
    });
  } else if (rule.triggerType === 'llm') {
    base = t('notification.watch.llmTriggered', { name: rule.name, reason: llmReason ?? '' });
  } else {
    base = t('notification.watch.matchTriggered', {
      name: rule.name,
      text: output.matchedText ?? '',
    });
  }
  if (unconfirmed) {
    base += t('notification.watch.unconfirmedSuffix');
  }
  return base;
}

export class WatchNotifier {
  constructor(private readonly deps: WatchNotifierDeps) {}

  buildPaneContext(rule: WatchRuleRecord): PaneLocationContext {
    const settings = this.deps.getSettings();
    return resolvePaneContext({
      deviceId: rule.deviceId,
      siteUrl: settings.siteUrl,
      snapshot: this.deps.getSnapshot(rule.deviceId),
      rawData: { paneId: rule.paneId },
    });
  }

  async emitTrigger(
    rule: WatchRuleRecord,
    output: WatchEvalOutput,
    summary: string | null,
    unconfirmed: boolean,
    llmReason?: string
  ): Promise<void> {
    const message = buildTriggerMessage(rule, output, summary, unconfirmed, llmReason);
    const paneContext = this.buildPaneContext(rule);
    await this.safeNotify(
      'watch_triggered',
      rule,
      {
        message,
        ruleId: rule.id,
        ruleName: rule.name,
        triggerType: rule.triggerType,
        ...(output.value !== undefined ? { value: output.value } : {}),
        ...(output.matchedText !== undefined ? { matchedText: output.matchedText } : {}),
        ...(output.stuckMinutes !== undefined ? { stuckMinutes: output.stuckMinutes } : {}),
        ...(summary ? { summary } : {}),
        ...(llmReason ? { reason: llmReason } : {}),
        ...(unconfirmed ? { unconfirmed: true } : {}),
      },
      paneContext
    );
    this.broadcastSafe(rule, wsBorsh.WATCH_EVENT_TRIGGERED, {
      summary: message,
      ...(output.matchedText !== undefined ? { matchedText: output.matchedText } : {}),
      ...(paneContext.windowId ? { windowId: paneContext.windowId } : {}),
    });
  }

  async raiseModelUnavailable(
    rule: WatchRuleRecord,
    alreadyNotified: boolean,
    error: unknown
  ): Promise<boolean> {
    if (alreadyNotified) {
      return true;
    }
    const message = t('notification.watch.modelUnavailable', {
      name: rule.name,
      message: toErrorMessage(error),
    });
    await this.safeNotify('watch_model_unavailable', rule, {
      message,
      ruleId: rule.id,
      ruleName: rule.name,
    });
    this.broadcastSafe(rule, wsBorsh.WATCH_EVENT_MODEL_UNAVAILABLE, { message });
    return true;
  }

  async notifyRuleError(rule: WatchRuleRecord, errorCount: number, detail: string): Promise<void> {
    const message = t('notification.watch.ruleError', {
      name: rule.name,
      count: errorCount,
      message: detail,
    });
    await this.safeNotify('watch_rule_error', rule, {
      message,
      ruleId: rule.id,
      ruleName: rule.name,
      consecutiveErrors: errorCount,
    });
    this.broadcastSafe(rule, wsBorsh.WATCH_EVENT_RULE_ERROR, { message });
  }

  async notifyPaneGone(rule: WatchRuleRecord): Promise<void> {
    const message = t('notification.watch.paneGone', {
      name: rule.name,
      paneId: rule.paneId,
    });
    await this.safeNotify(
      'watch_rule_error',
      rule,
      {
        message,
        ruleId: rule.id,
        ruleName: rule.name,
        paneGone: true,
      },
      { paneId: rule.paneId }
    );
    this.broadcastSafe(rule, wsBorsh.WATCH_EVENT_RULE_ERROR, { message });
  }

  async safeNotify(
    eventType: EventType,
    rule: WatchRuleRecord,
    payload: Record<string, unknown>,
    paneContext: PaneLocationContext = this.buildPaneContext(rule)
  ): Promise<void> {
    try {
      const settings = this.deps.getSettings();
      const device = this.deps.getDevice(rule.deviceId);
      await this.deps.notify(eventType, {
        site: {
          name: settings.siteName,
          url: settings.siteUrl,
        },
        device: {
          id: device?.id ?? rule.deviceId,
          name: device?.name ?? 'unknown',
          type: device?.type ?? 'local',
          host: device?.host,
        },
        tmux: {
          sessionName: device?.session,
          windowId: paneContext.windowId,
          windowIndex: paneContext.windowIndex,
          paneId: paneContext.paneId ?? rule.paneId,
          paneIndex: paneContext.paneIndex,
          paneUrl: paneContext.paneUrl,
          paneTitle: paneContext.paneTitle,
          paneCurrentCommand: paneContext.paneCurrentCommand,
        },
        payload,
      });
    } catch (error) {
      console.error(`[watch] notify ${eventType} failed for rule ${rule.id}:`, error);
    }
  }

  broadcastSafe<K extends keyof WatchEventPayloadMap>(
    rule: WatchRuleRecord,
    eventType: K,
    payload: WatchEventPayloadMap[K]
  ): void {
    try {
      this.deps.broadcast(rule.id, rule.deviceId, rule.paneId, eventType, payload);
    } catch (error) {
      console.error(`[watch] broadcast failed for rule ${rule.id}:`, error);
    }
  }
}
