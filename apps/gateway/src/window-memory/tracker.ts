import type { WindowMemorySettings } from '@vibeterm/shared';

import {
  HOST_SHELL_MAX_OUTPUT_BYTES,
  HOST_SHELL_TIMEOUT_MS,
  SAMPLE_INTERVAL_MAX_SEC,
  SAMPLE_INTERVAL_MIN_SEC,
  STOP_SCOPE_TIMEOUT_MS,
  TICK_DEBOUNCE_MS,
} from './constants';
import { type SamplerParseResult, parseSamplerOutput } from './sample-parser';
import { buildSamplerScript } from './sampler-script';
import { buildStopScopeScript, isAllZeroLimits } from './scope-commands';
import {
  type MemoryPaneRef,
  type PaneMemoryState,
  aggregateWindows,
  applyScopeLimit,
  collectOomEvents,
  observedLimited,
  releaseScopeLimit,
  vanishedWindowIds,
  windowNeedsEmit,
} from './tracker-ops';
import type {
  HostShellRunner,
  WindowMemoryAggregate,
  WindowMemoryConnectionHooks,
  WindowMemoryTracker,
} from './types';

const TRANSIENT_UNSUPPORTED_PIN = 6;
const MEASURE_MISS_PIN = 6;
const MEASURE_MISS_BACKOFF_MS = 60_000;
const VANISH_MISS_TICKS = 2;

export interface WindowMemorySchedule {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface WindowMemoryTrackerHandle extends WindowMemoryTracker {
  requestTickSoon(): void;
}

export interface CreateWindowMemoryTrackerOptions {
  deviceId: string;
  host: HostShellRunner;
  hooks: WindowMemoryConnectionHooks;
  getPanes: () => MemoryPaneRef[];
  now?: () => number;
  schedule?: WindowMemorySchedule;
}

const systemSchedule: WindowMemorySchedule = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function intervalMs(settings: WindowMemorySettings): number {
  const sec = Math.min(
    SAMPLE_INTERVAL_MAX_SEC,
    Math.max(SAMPLE_INTERVAL_MIN_SEC, settings.sampleIntervalSec)
  );
  return sec * 1000;
}

function emptyState(pane: MemoryPaneRef): PaneMemoryState {
  return {
    paneId: pane.paneId,
    windowId: pane.windowId,
    windowName: pane.windowName,
    scope: null,
    sample: null,
    oomKills: 0,
    applyAttempts: 0,
    applyFailedAt: null,
    desiredKey: '',
  };
}

class WindowMemoryTrackerImpl implements WindowMemoryTrackerHandle {
  supported: boolean | null = null;
  limitsSupported: boolean | null = null;
  private readonly deviceId: string;
  private readonly host: HostShellRunner;
  private readonly hooks: WindowMemoryConnectionHooks;
  private readonly getPanes: () => MemoryPaneRef[];
  private readonly now: () => number;
  private readonly schedule: WindowMemorySchedule;
  private readonly paneStates = new Map<string, PaneMemoryState>();
  private readonly lastSent = new Map<string, { at: number; window: WindowMemoryAggregate }>();
  private windows: WindowMemoryAggregate[] = [];
  private started = false;
  private stopped = false;
  private inFlight = false;
  private intervalTimer: unknown = null;
  private debounceTimer: unknown = null;
  private knownWindowIds = new Set<string>();
  private knownSeeded = false;
  private readonly windowMisses = new Map<string, number>();
  private limitsCgroupPinned = false;
  private transientLimitMisses = 0;
  private measureMisses = 0;
  private disabledSampled = false;

  constructor(opts: CreateWindowMemoryTrackerOptions) {
    this.deviceId = opts.deviceId;
    this.host = opts.host;
    this.hooks = opts.hooks;
    this.getPanes = opts.getPanes;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? systemSchedule;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.tick().finally(() => this.armInterval());
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.clearTimers();
  }

  requestTickSoon(): void {
    if (this.stopped) return;
    if (this.debounceTimer !== null) this.schedule.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.schedule.setTimeout(() => {
      this.debounceTimer = null;
      void this.tick();
    }, TICK_DEBOUNCE_MS);
  }

  getWindows(): WindowMemoryAggregate[] {
    return this.windows.slice();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.runTick();
    } catch (error) {
      console.warn(
        `[vibeterm][window-memory] tick failed device=${this.deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      this.inFlight = false;
    }
  }

  async stopScopesForWindow(windowId: string): Promise<void> {
    const scopes = this.scopesFor((state) => state.windowId === windowId);
    await this.stopScopes(scopes, `window=${windowId}`);
    this.hooks.oomMarks.clear(this.deviceId, windowId);
    this.lastSent.delete(windowId);
    this.knownWindowIds.delete(windowId);
    this.windowMisses.delete(windowId);
  }

  async stopScopesForPane(paneId: string): Promise<void> {
    const scopes = this.scopesFor((state) => state.paneId === paneId);
    await this.stopScopes(scopes, `pane=${paneId}`);
  }

  private scopesFor(match: (state: PaneMemoryState) => boolean): string[] {
    const scopes: string[] = [];
    for (const state of this.paneStates.values()) {
      if (match(state) && state.scope && !scopes.includes(state.scope)) scopes.push(state.scope);
    }
    return scopes;
  }

  private async stopScopes(scopes: string[], target: string): Promise<void> {
    if (scopes.length === 0) return;
    console.info(`[tmux] stop-scope ${target} scopes=${scopes.join(',')}`);
    try {
      const result = await this.host.runHostShell(buildStopScopeScript(scopes), {
        timeoutMs: STOP_SCOPE_TIMEOUT_MS,
      });
      if (result.exitCode === 0) return;
      console.warn(
        `[tmux] stop-scope failed ${target}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      );
    } catch (error) {
      console.warn(
        `[tmux] stop-scope failed ${target}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private sampleDelayMs(): number {
    const ms = intervalMs(this.hooks.getSettings());
    if (this.supported === false) return Math.max(ms, MEASURE_MISS_BACKOFF_MS);
    return ms;
  }

  private armInterval(): void {
    if (this.stopped) return;
    if (this.intervalTimer !== null) this.schedule.clearTimeout(this.intervalTimer);
    this.intervalTimer = this.schedule.setTimeout(() => {
      this.intervalTimer = null;
      void this.tick().finally(() => this.armInterval());
    }, this.sampleDelayMs());
  }

  private clearTimers(): void {
    if (this.intervalTimer !== null) this.schedule.clearTimeout(this.intervalTimer);
    if (this.debounceTimer !== null) this.schedule.clearTimeout(this.debounceTimer);
    this.intervalTimer = null;
    this.debounceTimer = null;
  }

  private async runTick(): Promise<void> {
    const settings = this.hooks.getSettings();
    const panes = this.getPanes();
    this.pruneVanished(panes);
    if (!settings.enabled && this.disabledSampled && !this.hasObservedLimits()) return;
    const parsed = await this.sampleHost(panes);
    if (!parsed) return;
    this.updateLimitsSupported(parsed);
    this.syncPaneStates(panes, parsed.panes);
    this.refineLimitsByScopes();
    if (!this.acceptMeasure(panes)) return;
    await this.applyOrRelease(settings);
    if (!settings.enabled) {
      this.disabledSampled = true;
      return;
    }
    this.disabledSampled = false;
    const now = this.now();
    this.emitOom();
    this.emitWindows(panes, now);
  }

  private async applyOrRelease(settings: WindowMemorySettings): Promise<void> {
    if (this.limitsSupported === false) return;
    const release = !settings.enabled || isAllZeroLimits(settings);
    const now = this.now();
    for (const state of this.paneStates.values()) {
      if (release) await releaseScopeLimit(this.host, this.deviceId, state, now);
      else await applyScopeLimit(this.host, this.deviceId, state, settings, now);
    }
  }

  private hasObservedLimits(): boolean {
    for (const state of this.paneStates.values()) {
      if (state.sample && observedLimited(state.sample)) return true;
    }
    return false;
  }

  private updateLimitsSupported(parsed: SamplerParseResult): void {
    if (this.limitsCgroupPinned) {
      this.limitsSupported = false;
      return;
    }
    if (parsed.limitsSupported) {
      this.transientLimitMisses = 0;
      this.limitsSupported = true;
      return;
    }
    if (parsed.reason === 'no-cgroup2') {
      this.limitsCgroupPinned = true;
      this.limitsSupported = false;
      return;
    }
    this.transientLimitMisses += 1;
    if (this.transientLimitMisses >= TRANSIENT_UNSUPPORTED_PIN) {
      this.limitsSupported = false;
    }
  }

  /**
   * cgroup v2 与用户级 systemd 都在，不等于限额真的能套上：tmux < 3.6（或没编 systemd 支持）
   * 不会给 pane 建 `tmux-spawn-*.scope`，限额没有着落点。有样本的 pane 一个 scope 都没有时，
   * 这台宿主就是限不了——每 tick 重算，换了 tmux 之后能自己恢复。
   */
  private refineLimitsByScopes(): void {
    if (this.limitsSupported !== true) return;
    let measured = 0;
    let scoped = 0;
    for (const state of this.paneStates.values()) {
      if (!state.sample || state.sample.source === 'none') continue;
      measured += 1;
      if (state.sample.scope) scoped += 1;
    }
    if (measured > 0 && scoped === 0) this.limitsSupported = false;
  }

  private acceptMeasure(panes: MemoryPaneRef[]): boolean {
    if (panes.length === 0) return true;
    const hasMeasured = [...this.paneStates.values()].some(
      (state) => state.sample != null && state.sample.source !== 'none'
    );
    if (hasMeasured) {
      this.measureMisses = 0;
      const was = this.supported;
      if (was !== true) {
        this.supported = true;
        this.hooks.onSupport?.(true);
        if (was === false) this.armInterval();
      }
      return true;
    }
    this.measureMisses += 1;
    if (this.measureMisses >= MEASURE_MISS_PIN) {
      this.noteMeasureUnsupported();
      return false;
    }
    return true;
  }

  private noteMeasureUnsupported(): void {
    const was = this.supported;
    this.supported = false;
    if (was !== false) {
      this.hooks.onSupport?.(false);
      console.info(`[vibeterm][window-memory] unsupported device=${this.deviceId}`);
      this.armInterval();
    }
  }

  private async sampleHost(panes: MemoryPaneRef[]): Promise<SamplerParseResult | null> {
    const listed = panes.filter((pane) => Number.isInteger(pane.pid) && (pane.pid ?? 0) > 0);
    const script = buildSamplerScript(
      listed.map((pane) => ({ paneId: pane.paneId, pid: pane.pid as number }))
    );
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await this.host.runHostShell(script, {
        timeoutMs: HOST_SHELL_TIMEOUT_MS,
        maxOutputBytes: HOST_SHELL_MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      console.warn(
        `[vibeterm][window-memory] sample failed device=${this.deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
    if (result.exitCode !== 0) {
      console.warn(
        `[vibeterm][window-memory] sample failed device=${this.deviceId}: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`
      );
      return null;
    }
    try {
      return parseSamplerOutput(result.stdout);
    } catch (error) {
      console.warn(
        `[vibeterm][window-memory] sample parse failed device=${this.deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private syncPaneStates(
    panes: MemoryPaneRef[],
    samples: NonNullable<PaneMemoryState['sample']>[]
  ): void {
    const live = new Set(panes.map((pane) => pane.paneId));
    for (const paneId of [...this.paneStates.keys()]) {
      if (!live.has(paneId)) this.paneStates.delete(paneId);
    }
    const byId = new Map(samples.map((sample) => [sample.paneId, sample]));
    for (const pane of panes) {
      const state = this.paneStates.get(pane.paneId) ?? emptyState(pane);
      state.windowId = pane.windowId;
      state.windowName = pane.windowName;
      const sample = byId.get(pane.paneId) ?? null;
      state.sample = sample;
      state.scope = sample?.scope ?? null;
      this.paneStates.set(pane.paneId, state);
    }
  }

  private emitOom(): void {
    for (const event of collectOomEvents(this.deviceId, this.paneStates.values())) {
      this.hooks.oomMarks.mark(event.deviceId, event.windowId, event.scope, event.oomKills);
      this.hooks.onOomKill(event);
    }
  }

  private emitWindows(panes: MemoryPaneRef[], now: number): void {
    const next = aggregateWindows(
      panes,
      this.paneStates,
      (windowId) => this.hooks.oomMarks.has(this.deviceId, windowId),
      now
    );
    this.windows = next;
    for (const windowId of vanishedWindowIds(
      this.lastSent.keys(),
      next.map((window) => window.windowId)
    )) {
      this.lastSent.delete(windowId);
    }
    const changed = next.filter((window) => {
      const prev = this.lastSent.get(window.windowId);
      return windowNeedsEmit(prev?.window, window, prev?.at, now);
    });
    for (const window of changed) {
      this.lastSent.set(window.windowId, { at: now, window });
    }
    if (changed.length > 0) this.hooks.onSample(changed);
  }

  private seedKnownWindows(current: Set<string>): void {
    if (this.knownSeeded) return;
    this.knownSeeded = true;
    for (const id of current) this.knownWindowIds.add(id);
    for (const id of this.hooks.oomMarks.listWindowIds(this.deviceId)) {
      this.knownWindowIds.add(id);
    }
  }

  private pruneVanished(panes: MemoryPaneRef[]): void {
    const current = new Set(panes.map((pane) => pane.windowId));
    this.seedKnownWindows(current);
    const candidates = new Set(this.knownWindowIds);
    for (const id of this.hooks.oomMarks.listWindowIds(this.deviceId)) candidates.add(id);
    for (const windowId of candidates) {
      if (current.has(windowId)) {
        this.windowMisses.delete(windowId);
        this.knownWindowIds.add(windowId);
        continue;
      }
      const misses = (this.windowMisses.get(windowId) ?? 0) + 1;
      if (misses < VANISH_MISS_TICKS) {
        this.windowMisses.set(windowId, misses);
        continue;
      }
      this.hooks.oomMarks.clear(this.deviceId, windowId);
      this.lastSent.delete(windowId);
      this.knownWindowIds.delete(windowId);
      this.windowMisses.delete(windowId);
    }
  }
}

export function createWindowMemoryTracker(
  opts: CreateWindowMemoryTrackerOptions
): WindowMemoryTrackerHandle {
  return new WindowMemoryTrackerImpl(opts);
}
