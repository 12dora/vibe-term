import type { WindowMemorySettings } from '@vibeterm/shared';

import { APPLY_RETRY_MS, HEARTBEAT_MS, HOST_SHELL_TIMEOUT_MS, MIB_BYTES } from './constants';
import { argvToScript, buildSetPropertyArgs } from './scope-commands';
import type {
  HostShellRunner,
  PaneScopeSample,
  WindowMemoryAggregate,
  WindowOomKillEvent,
} from './types';

export interface PaneMemoryState {
  paneId: string;
  windowId: string;
  windowName: string;
  scope: string | null;
  sample: PaneScopeSample | null;
  oomKills: number;
  applyAttempts: number;
  applyFailedAt: number | null;
  desiredKey: string;
}

export interface MemoryPaneRef {
  paneId: string;
  windowId: string;
  windowName: string;
  pid?: number;
}

export function minNonZero(values: number[]): number {
  let min = 0;
  for (const value of values) {
    if (value <= 0) continue;
    if (min === 0 || value < min) min = value;
  }
  return min;
}

export function bytesOfMb(mb: number): number {
  return mb > 0 ? mb * MIB_BYTES : 0;
}

export function limitsDiffer(settings: WindowMemorySettings, sample: PaneScopeSample): boolean {
  if (settings.memoryHighMb > 0 && sample.high !== bytesOfMb(settings.memoryHighMb)) return true;
  if (settings.memoryMaxMb > 0 && sample.max !== bytesOfMb(settings.memoryMaxMb)) return true;
  if (settings.memorySwapMaxMb > 0 && sample.swapMax !== bytesOfMb(settings.memorySwapMaxMb)) {
    return true;
  }
  return false;
}

export function needsApply(settings: WindowMemorySettings, sample: PaneScopeSample): boolean {
  if (!sample.scope) return false;
  if (!buildSetPropertyArgs(sample.scope, settings)) return false;
  return !sample.managed || limitsDiffer(settings, sample);
}

export function canRetryApply(state: PaneMemoryState, now: number): boolean {
  if (state.applyAttempts >= 2) return false;
  if (state.applyAttempts === 0 || state.applyFailedAt === null) return true;
  return now - state.applyFailedAt >= APPLY_RETRY_MS;
}

export async function applyScopeLimit(
  host: HostShellRunner,
  deviceId: string,
  state: PaneMemoryState,
  settings: WindowMemorySettings,
  now: number
): Promise<void> {
  const scope = state.scope;
  if (!scope || !state.sample) return;
  const args = buildSetPropertyArgs(scope, settings);
  const desiredKey = args ? args.join('\0') : '';
  if (desiredKey !== state.desiredKey) {
    state.applyAttempts = 0;
    state.applyFailedAt = null;
    state.desiredKey = desiredKey;
  }
  if (!args || !needsApply(settings, state.sample) || !canRetryApply(state, now)) return;
  const result = await host.runHostShell(argvToScript(args), { timeoutMs: HOST_SHELL_TIMEOUT_MS });
  if (result.exitCode === 0) {
    state.applyAttempts = 0;
    state.applyFailedAt = null;
    state.sample.managed = true;
    return;
  }
  state.applyAttempts += 1;
  state.applyFailedAt = now;
  const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
  console.warn(
    `[vibeterm][window-memory] set-property failed device=${deviceId} pane=${state.paneId} scope=${scope}: ${stderr}`
  );
}

export function collectOomEvents(
  deviceId: string,
  states: Iterable<PaneMemoryState>
): WindowOomKillEvent[] {
  const events: WindowOomKillEvent[] = [];
  for (const state of states) {
    const sample = state.sample;
    if (!sample?.scope) continue;
    if (sample.oomKills <= state.oomKills) {
      state.oomKills = sample.oomKills;
      continue;
    }
    state.oomKills = sample.oomKills;
    events.push({
      deviceId,
      windowId: state.windowId,
      paneId: state.paneId,
      scope: sample.scope,
      oomKills: sample.oomKills,
      current: sample.current,
      high: sample.high,
      max: sample.max,
    });
  }
  return events;
}

function scopesOf(states: PaneMemoryState[]): string[] {
  const names: string[] = [];
  for (const state of states) {
    if (state.scope && !names.includes(state.scope)) names.push(state.scope);
  }
  names.sort();
  return names;
}

export function aggregateWindows(
  panes: MemoryPaneRef[],
  states: Map<string, PaneMemoryState>,
  oomFlag: (windowId: string) => boolean,
  sampledAt: number
): WindowMemoryAggregate[] {
  const byWindow = new Map<string, MemoryPaneRef[]>();
  for (const pane of panes) {
    const list = byWindow.get(pane.windowId) ?? [];
    list.push(pane);
    byWindow.set(pane.windowId, list);
  }
  const windows: WindowMemoryAggregate[] = [];
  for (const [windowId, windowPanes] of byWindow) {
    const paneStates = windowPanes
      .map((pane) => states.get(pane.paneId))
      .filter((state): state is PaneMemoryState => Boolean(state));
    windows.push({
      windowId,
      windowName: windowPanes[0]?.windowName ?? '',
      panes: windowPanes.length,
      scopes: scopesOf(paneStates),
      current: paneStates.reduce((sum, state) => sum + (state.sample?.current ?? 0), 0),
      high: minNonZero(paneStates.map((state) => state.sample?.high ?? 0)),
      max: minNonZero(paneStates.map((state) => state.sample?.max ?? 0)),
      swapMax: minNonZero(paneStates.map((state) => state.sample?.swapMax ?? 0)),
      oomKills: paneStates.reduce((sum, state) => sum + (state.sample?.oomKills ?? 0), 0),
      oomFlag: oomFlag(windowId),
      sampledAt,
    });
  }
  return windows;
}

export function windowNeedsEmit(
  prev: WindowMemoryAggregate | undefined,
  next: WindowMemoryAggregate,
  lastSentAt: number | undefined,
  now: number
): boolean {
  if (!prev || lastSentAt === undefined || now - lastSentAt >= HEARTBEAT_MS) return true;
  if (Math.abs(next.current - prev.current) >= MIB_BYTES) return true;
  if (prev.high !== next.high || prev.max !== next.max || prev.swapMax !== next.swapMax) {
    return true;
  }
  if (prev.oomKills !== next.oomKills || prev.oomFlag !== next.oomFlag) return true;
  if (prev.panes !== next.panes || prev.windowName !== next.windowName) return true;
  return prev.scopes.join('\0') !== next.scopes.join('\0');
}

export function vanishedWindowIds(previous: Iterable<string>, current: Iterable<string>): string[] {
  const live = new Set(current);
  const gone: string[] = [];
  for (const windowId of previous) {
    if (!live.has(windowId)) gone.push(windowId);
  }
  return gone;
}
