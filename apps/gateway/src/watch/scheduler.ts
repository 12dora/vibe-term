import type { WatchRuleRecord } from '../db/watch';

export const MIN_INTERVAL_SECONDS = 5;
export const MIN_LLM_INTERVAL_SECONDS = 30;

export function effectiveIntervalSeconds(
  rule: Pick<WatchRuleRecord, 'triggerType' | 'intervalSeconds'>
): number {
  const min = rule.triggerType === 'llm' ? MIN_LLM_INTERVAL_SECONDS : MIN_INTERVAL_SECONDS;
  return Math.max(min, rule.intervalSeconds);
}

export interface ScheduledRule {
  ruleId: string;
  deviceId: string;
  clearTimer: (() => void) | null;
  tickPromise: Promise<void> | null;
}

export class WatchRuleScheduler {
  private readonly rules = new Map<string, ScheduledRule>();

  has(ruleId: string): boolean {
    return this.rules.has(ruleId);
  }

  get(ruleId: string): ScheduledRule | undefined {
    return this.rules.get(ruleId);
  }

  ruleIds(): string[] {
    return Array.from(this.rules.keys());
  }

  add(
    rule: Pick<WatchRuleRecord, 'id' | 'deviceId' | 'triggerType' | 'intervalSeconds'>,
    onTick: (ruleId: string) => void,
    scheduleInterval: (fn: () => void, ms: number) => () => void
  ): ScheduledRule | null {
    if (this.rules.has(rule.id)) {
      return null;
    }
    const entry: ScheduledRule = {
      ruleId: rule.id,
      deviceId: rule.deviceId,
      clearTimer: null,
      tickPromise: null,
    };
    entry.clearTimer = scheduleInterval(
      () => onTick(rule.id),
      effectiveIntervalSeconds(rule) * 1000
    );
    this.rules.set(rule.id, entry);
    return entry;
  }

  detach(ruleId: string): ScheduledRule | undefined {
    const entry = this.rules.get(ruleId);
    if (!entry) {
      return undefined;
    }
    this.rules.delete(ruleId);
    entry.clearTimer?.();
    entry.clearTimer = null;
    return entry;
  }

  async runExclusive(ruleId: string, fn: () => Promise<void>): Promise<void> {
    const entry = this.rules.get(ruleId);
    if (!entry || entry.tickPromise) {
      return;
    }
    const promise = (async () => {
      try {
        await fn();
      } catch (error) {
        console.error(`[watch] tick failed for rule ${ruleId}:`, error);
      }
    })().finally(() => {
      if (entry.tickPromise === promise) {
        entry.tickPromise = null;
      }
    });
    entry.tickPromise = promise;
    return promise;
  }

  async waitForTick(entry: ScheduledRule): Promise<void> {
    if (entry.tickPromise) {
      await entry.tickPromise.catch(() => undefined);
    }
  }
}
