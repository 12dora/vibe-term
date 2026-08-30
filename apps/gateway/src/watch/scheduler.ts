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
  deadline: number;
  tickPromise: Promise<void> | null;
}

interface PaneGroup {
  deviceId: string;
  paneId: string;
  ruleIds: Set<string>;
  armedDeadline: number;
  clearTimer: (() => void) | null;
  onTick: (deviceId: string, paneId: string) => void;
  scheduleInterval: (fn: () => void, ms: number) => () => void;
}

interface PaneInflight {
  promise: Promise<void>;
  pending: boolean;
}

export interface WatchRuleSchedulerOptions {
  now?: () => number;
}

export class WatchRuleScheduler {
  private readonly rules = new Map<string, ScheduledRule>();
  private readonly groups = new Map<string, PaneGroup>();
  private readonly inflight = new Map<string, PaneInflight>();
  private readonly now: () => number;

  constructor(options: WatchRuleSchedulerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

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
    const intervalMs = effectiveIntervalSeconds(rule) * 1000;
    const entry: ScheduledRule = {
      ruleId: rule.id,
      deviceId: rule.deviceId,
      paneId: rule.paneId,
      intervalMs,
      deadline: this.now() + intervalMs,
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
    const now = this.now();
    const due: string[] = [];
    for (const ruleId of group.ruleIds) {
      const entry = this.rules.get(ruleId);
      if (!entry || entry.deadline > now) {
        continue;
      }
      entry.deadline = now + entry.intervalMs;
      due.push(ruleId);
    }
    this.armGroup(group);
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
      this.groups.delete(key);
      return entry;
    }
    this.armGroup(group);
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
    const key = paneKey(deviceId, paneId);
    const existing = this.inflight.get(key);
    if (existing) {
      existing.pending = true;
      return existing.promise;
    }
    if (!this.groups.has(key)) {
      return;
    }
    const state: PaneInflight = { promise: Promise.resolve(), pending: false };
    const promise = (async () => {
      try {
        do {
          state.pending = false;
          await fn();
        } while (state.pending);
      } catch (error) {
        console.error(`[watch] pane tick failed for ${deviceId} ${paneId}:`, error);
      } finally {
        if (this.inflight.get(key) === state) {
          this.inflight.delete(key);
        }
      }
    })();
    state.promise = promise;
    this.inflight.set(key, state);
    return promise;
  }

  async waitForTick(entry: ScheduledRule): Promise<void> {
    if (entry.tickPromise) {
      await entry.tickPromise.catch(() => undefined);
    }
    const pane = this.inflight.get(paneKey(entry.deviceId, entry.paneId));
    if (pane) {
      await pane.promise.catch(() => undefined);
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
        armedDeadline: entry.deadline,
        clearTimer: null,
        onTick,
        scheduleInterval,
      };
      this.groups.set(key, group);
      this.armGroup(group);
      return;
    }
    group.ruleIds.add(entry.ruleId);
    if (!group.clearTimer || entry.deadline < group.armedDeadline) {
      this.armGroup(group);
    }
  }

  private armGroup(group: PaneGroup): void {
    group.clearTimer?.();
    let nearest = Number.POSITIVE_INFINITY;
    for (const id of group.ruleIds) {
      const remaining = this.rules.get(id);
      if (remaining && remaining.deadline < nearest) {
        nearest = remaining.deadline;
      }
    }
    if (!Number.isFinite(nearest)) {
      group.clearTimer = null;
      return;
    }
    group.armedDeadline = nearest;
    group.clearTimer = group.scheduleInterval(
      () => group.onTick(group.deviceId, group.paneId),
      Math.max(0, Math.round(nearest - this.now()))
    );
  }
}
