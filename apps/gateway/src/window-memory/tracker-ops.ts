import type { WindowMemorySettings } from '@vibeterm/shared';

import { APPLY_RETRY_MS, HEARTBEAT_MS, HOST_SHELL_TIMEOUT_MS, MIB_BYTES } from './constants';
import {
  argvToScript,
  buildReleasePropertyArgs,
  buildSetPropertyArgs,
  isAllZeroLimits,
} from './scope-commands';
import type {
  HostShellRunner,
  PaneMemorySource,
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

export function observedLimited(sample: PaneScopeSample): boolean {
  return sample.high > 0 || sample.max > 0 || sample.swapMax > 0;
}

export function limitsDiffer(settings: WindowMemorySettings, sample: PaneScopeSample): boolean {
  return (
    sample.high !== bytesOfMb(settings.memoryHighMb) ||
    sample.max !== bytesOfMb(settings.memoryMaxMb) ||
    sample.swapMax !== bytesOfMb(settings.memorySwapMaxMb)
  );
}

export function needsApply(settings: WindowMemorySettings, sample: PaneScopeSample): boolean {
  if (!sample.scope) return false;
  if (isAllZeroLimits(settings)) return false;
  return limitsDiffer(settings, sample);
}

export function canRetryApply(state: PaneMemoryState, now: number): boolean {
  if (state.applyAttempts >= 2) return false;
  if (state.applyAttempts === 0 || state.applyFailedAt === null) return true;
  return now - state.applyFailedAt >= APPLY_RETRY_MS;
}

async function runSetProperty(
  host: HostShellRunner,
  deviceId: string,
  state: PaneMemoryState,
  args: string[],
  now: number
): Promise<boolean> {
  const desiredKey = args.join('\0');
  if (desiredKey !== state.desiredKey) {
    state.applyAttempts = 0;
    state.applyFailedAt = null;
    state.desiredKey = desiredKey;
  }
  if (!canRetryApply(state, now)) return false;
  const result = await host.runHostShell(argvToScript(args), { timeoutMs: HOST_SHELL_TIMEOUT_MS });
  if (result.exitCode === 0) {
    state.applyAttempts = 0;
    state.applyFailedAt = null;
    return true;
  }
  state.applyAttempts += 1;
  state.applyFailedAt = now;
  const stderr = result.stderr.trim() || `exit ${result.exitCode}`;
  console.warn(
    `[vibeterm][window-memory] set-property failed device=${deviceId} pane=${state.paneId} scope=${state.scope}: ${stderr}`
  );
  return false;
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
  if (!args || !needsApply(settings, state.sample)) return;
  if (await runSetProperty(host, deviceId, state, args, now)) {
    state.sample.managed = true;
  }
}

export async function releaseScopeLimit(
  host: HostShellRunner,
  deviceId: string,
  state: PaneMemoryState,
  now: number
): Promise<void> {
  const scope = state.scope;
  if (!scope || !state.sample || !observedLimited(state.sample)) return;
  const args = buildReleasePropertyArgs(scope);
  if (await runSetProperty(host, deviceId, state, args, now)) {
    state.sample.managed = false;
    state.sample.high = 0;
    state.sample.max = 0;
    state.sample.swapMax = 0;
  }
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

function aggregateSource(paneStates: PaneMemoryState[]): PaneMemorySource {
  let sawCgroup = false;
  let sawRss = false;
  for (const state of paneStates) {
    const source = state.sample?.source;
    if (source === 'rss') sawRss = true;
    else if (source === 'cgroup') sawCgroup = true;
  }
  if (sawRss) return 'rss';
  if (sawCgroup) return 'cgroup';
  return 'none';
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
    const source = aggregateSource(paneStates);
    if (source === 'none') continue;
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
      source,
    });
  }
  return windows;
}

function windowReadingChanged(prev: WindowMemoryAggregate, next: WindowMemoryAggregate): boolean {
  if (Math.abs(next.current - prev.current) >= MIB_BYTES) return true;
  if (prev.high !== next.high || prev.max !== next.max || prev.swapMax !== next.swapMax) {
    return true;
  }
  if (prev.oomKills !== next.oomKills || prev.oomFlag !== next.oomFlag) return true;
  return prev.source !== next.source;
}

function windowShapeChanged(prev: WindowMemoryAggregate, next: WindowMemoryAggregate): boolean {
  if (prev.panes !== next.panes || prev.windowName !== next.windowName) return true;
  return prev.scopes.join('\0') !== next.scopes.join('\0');
}

export function windowNeedsEmit(
  prev: WindowMemoryAggregate | undefined,
  next: WindowMemoryAggregate,
  lastSentAt: number | undefined,
  now: number
): boolean {
  if (!prev || lastSentAt === undefined || now - lastSentAt >= HEARTBEAT_MS) return true;
  return windowReadingChanged(prev, next) || windowShapeChanged(prev, next);
}

export function vanishedWindowIds(previous: Iterable<string>, current: Iterable<string>): string[] {
  const live = new Set(current);
  const gone: string[] = [];
  for (const windowId of previous) {
    if (!live.has(windowId)) gone.push(windowId);
  }
  return gone;
}
