import type { WatchRuleRecord } from '../db/watch';

export const MIN_INTERVAL_SECONDS = 5;
export const MIN_LLM_INTERVAL_SECONDS = 30;

export function effectiveIntervalSeconds(
  rule: Pick<WatchRuleRecord, 'triggerType' | 'intervalSeconds'>
): number {
  const min = rule.triggerType === 'llm' ? MIN_LLM_INTERVAL_SECONDS : MIN_INTERVAL_SECONDS;
  return Math.max(min, rule.intervalSeconds);
}

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

export interface ScheduledRule {
  ruleId: string;
  deviceId: string;
  paneId: string;
  intervalMs: number;
  accruedMs: number;
  clearTimer: (() => void) | null;
  tickPromise: Promise<void> | null;
}

interface PaneGroup {
  deviceId: string;
  paneId: string;
  ruleIds: Set<string>;
  minIntervalMs: number;
  clearTimer: (() => void) | null;
  tickPromise: Promise<void> | null;
  onTick: (deviceId: string, paneId: string) => void;
  scheduleInterval: (fn: () => void, ms: number) => () => void;
}

export class WatchRuleScheduler {
  private readonly rules = new Map<string, ScheduledRule>();
  private readonly groups = new Map<string, PaneGroup>();

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
    rule: Pick<WatchRuleRecord, 'id' | 'deviceId' | 'paneId' | 'triggerType' | 'intervalSeconds'>,
    onTick: (deviceId: string, paneId: string) => void,
    scheduleInterval: (fn: () => void, ms: number) => () => void
  ): ScheduledRule | null {
    if (this.rules.has(rule.id)) {
      return null;
    }
    const entry: ScheduledRule = {
      ruleId: rule.id,
      deviceId: rule.deviceId,
      paneId: rule.paneId,
      intervalMs: effectiveIntervalSeconds(rule) * 1000,
      accruedMs: 0,
      clearTimer: null,
      tickPromise: null,
    };
    this.rules.set(rule.id, entry);
    this.attachToGroup(entry, onTick, scheduleInterval);
    return entry;
  }

  takeDueRuleIds(deviceId: string, paneId: string): string[] {
    const group = this.groups.get(paneKey(deviceId, paneId));
    if (!group) {
      return [];
    }
    const due: string[] = [];
    for (const ruleId of group.ruleIds) {
      const entry = this.rules.get(ruleId);
      if (!entry) {
        continue;
      }
      entry.accruedMs += group.minIntervalMs;
      if (entry.accruedMs >= entry.intervalMs) {
        entry.accruedMs = 0;
        due.push(ruleId);
      }
    }
    return due;
  }

  detach(ruleId: string): ScheduledRule | undefined {
    const entry = this.rules.get(ruleId);
    if (!entry) {
      return undefined;
    }
    this.rules.delete(ruleId);
    const key = paneKey(entry.deviceId, entry.paneId);
    const group = this.groups.get(key);
    if (!group) {
      return entry;
    }
    group.ruleIds.delete(ruleId);
    if (group.ruleIds.size === 0) {
      group.clearTimer?.();
      group.clearTimer = null;
      if (!group.tickPromise) {
        this.groups.delete(key);
      }
      return entry;
    }
    let min = Number.POSITIVE_INFINITY;
    for (const id of group.ruleIds) {
      const remaining = this.rules.get(id);
      if (remaining && remaining.intervalMs < min) {
        min = remaining.intervalMs;
      }
    }
    if (min !== group.minIntervalMs) {
      group.minIntervalMs = min;
      this.armGroup(group);
    }
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

  async runPaneExclusive(deviceId: string, paneId: string, fn: () => Promise<void>): Promise<void> {
    const group = this.groups.get(paneKey(deviceId, paneId));
    if (!group || group.tickPromise) {
      return;
    }
    const promise = (async () => {
      try {
        await fn();
      } catch (error) {
        console.error(`[watch] pane tick failed for ${deviceId} ${paneId}:`, error);
      }
    })().finally(() => {
      if (group.tickPromise === promise) {
        group.tickPromise = null;
      }
      if (group.ruleIds.size === 0) {
        this.groups.delete(paneKey(deviceId, paneId));
      }
    });
    group.tickPromise = promise;
    return promise;
  }

  async waitForTick(entry: ScheduledRule): Promise<void> {
    if (entry.tickPromise) {
      await entry.tickPromise.catch(() => undefined);
    }
    const group = this.groups.get(paneKey(entry.deviceId, entry.paneId));
    if (group?.tickPromise) {
      await group.tickPromise.catch(() => undefined);
    }
  }

  private attachToGroup(
    entry: ScheduledRule,
    onTick: (deviceId: string, paneId: string) => void,
    scheduleInterval: (fn: () => void, ms: number) => () => void
  ): void {
    const key = paneKey(entry.deviceId, entry.paneId);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        deviceId: entry.deviceId,
        paneId: entry.paneId,
        ruleIds: new Set([entry.ruleId]),
        minIntervalMs: entry.intervalMs,
        clearTimer: null,
        tickPromise: null,
        onTick,
        scheduleInterval,
      };
      this.groups.set(key, group);
      this.armGroup(group);
      return;
    }
    group.ruleIds.add(entry.ruleId);
    if (entry.intervalMs < group.minIntervalMs) {
      group.minIntervalMs = entry.intervalMs;
      this.armGroup(group);
    }
  }

  private armGroup(group: PaneGroup): void {
    group.clearTimer?.();
    group.clearTimer = group.scheduleInterval(
      () => group.onTick(group.deviceId, group.paneId),
      group.minIntervalMs
    );
  }
}
