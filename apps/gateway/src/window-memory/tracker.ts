import type { WindowMemorySettings } from '@vibeterm/shared';

import {
  HOST_SHELL_MAX_OUTPUT_BYTES,
  HOST_SHELL_TIMEOUT_MS,
  SAMPLE_INTERVAL_MAX_SEC,
  SAMPLE_INTERVAL_MIN_SEC,
  STOP_SCOPE_TIMEOUT_MS,
  TICK_DEBOUNCE_MS,
} from './constants';
import { parseSamplerOutput } from './sample-parser';
import { buildSamplerScript } from './sampler-script';
import { buildStopScopeScript } from './scope-commands';
import {
  type MemoryPaneRef,
  type PaneMemoryState,
  aggregateWindows,
  applyScopeLimit,
  collectOomEvents,
  vanishedWindowIds,
  windowNeedsEmit,
} from './tracker-ops';
import type {
  HostShellRunner,
  PaneScopeSample,
  WindowMemoryAggregate,
  WindowMemoryConnectionHooks,
  WindowMemoryTracker,
} from './types';

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
    if (this.stopped || this.supported === false) return;
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
    if (this.stopped || this.inFlight || this.supported === false) return;
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

  private armInterval(): void {
    if (this.stopped || this.supported === false) return;
    if (this.intervalTimer !== null) this.schedule.clearTimeout(this.intervalTimer);
    this.intervalTimer = this.schedule.setTimeout(() => {
      this.intervalTimer = null;
      void this.tick().finally(() => this.armInterval());
    }, intervalMs(this.hooks.getSettings()));
  }

  private clearTimers(): void {
    if (this.intervalTimer !== null) this.schedule.clearTimeout(this.intervalTimer);
    if (this.debounceTimer !== null) this.schedule.clearTimeout(this.debounceTimer);
    this.intervalTimer = null;
    this.debounceTimer = null;
  }

  private async runTick(): Promise<void> {
    const settings = this.hooks.getSettings();
    if (!settings.enabled) return;
    const panes = this.getPanes();
    const parsed = await this.sampleHost(panes);
    if (!parsed) return;
    if (this.supported === null) {
      this.supported = parsed.supported;
      this.hooks.onSupport?.(parsed.supported);
      if (!parsed.supported) {
        console.info(`[vibeterm][window-memory] unsupported device=${this.deviceId}`);
        this.clearTimers();
        return;
      }
    }
    if (!parsed.supported) return;
    this.syncPaneStates(panes, parsed.panes);
    const now = this.now();
    for (const state of this.paneStates.values()) {
      await applyScopeLimit(this.host, this.deviceId, state, settings, now);
    }
    this.emitOom();
    this.emitWindows(panes, now);
    this.pruneVanished(panes);
  }

  private async sampleHost(
    panes: MemoryPaneRef[]
  ): Promise<{ supported: boolean; panes: PaneScopeSample[] } | null> {
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
    const changed = next.filter((window) => {
      const prev = this.lastSent.get(window.windowId);
      return windowNeedsEmit(prev?.window, window, prev?.at, now);
    });
    for (const window of changed) {
      this.lastSent.set(window.windowId, { at: now, window });
    }
    if (changed.length > 0) this.hooks.onSample(changed);
  }

  private pruneVanished(panes: MemoryPaneRef[]): void {
    const current = new Set(panes.map((pane) => pane.windowId));
    for (const windowId of vanishedWindowIds(this.knownWindowIds, current)) {
      this.hooks.oomMarks.clear(this.deviceId, windowId);
      this.lastSent.delete(windowId);
    }
    this.knownWindowIds = current;
  }
}

export function createWindowMemoryTracker(
  opts: CreateWindowMemoryTrackerOptions
): WindowMemoryTrackerHandle {
  return new WindowMemoryTrackerImpl(opts);
}
