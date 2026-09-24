import type { WindowMemorySettings } from '@vibeterm/shared';

import { type AppliedLimitTriple, observedMatchesAny } from './applied-triples';
import { APPLY_RETRY_MS, HEARTBEAT_MS, MIB_BYTES, RELEASE_BACKOFF_MAX_MS } from './constants';
import { buildReleasePropertyArgs, buildSetPropertyArgs, isAllZeroLimits } from './scope-commands';
import type {
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
  lastStderr: string;
  /** 套有限限额到达两次失败后打过一行 give-up。 */
  giveUpLogged: boolean;
  /** 释放命令退出码 0，但还没看到下一次采样变成无限。 */
  releaseUnverified: boolean;
}

export interface PlannedWrite {
  state: PaneMemoryState;
  args: string[];
  kind: 'apply' | 'release';
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

export function retryDelayMs(attempts: number, kind: 'apply' | 'release'): number {
  if (kind === 'apply' || attempts <= 1) return APPLY_RETRY_MS;
  const shift = Math.min(attempts - 1, 8);
  return Math.min(APPLY_RETRY_MS * 2 ** shift, RELEASE_BACKOFF_MAX_MS);
}

export function canRetryApply(
  state: PaneMemoryState,
  now: number,
  kind: 'apply' | 'release'
): boolean {
  if (kind === 'apply' && state.applyAttempts >= 2) return false;
  if (state.applyAttempts === 0 || state.applyFailedAt === null) return true;
  return now - state.applyFailedAt >= retryDelayMs(state.applyAttempts, kind);
}

function resetApplyState(state: PaneMemoryState, desiredKey: string): void {
  state.applyAttempts = 0;
  state.applyFailedAt = null;
  state.desiredKey = desiredKey;
  state.giveUpLogged = false;
  state.lastStderr = '';
  state.releaseUnverified = false;
}

function clearApplyFailure(state: PaneMemoryState): void {
  state.applyAttempts = 0;
  state.applyFailedAt = null;
  state.giveUpLogged = false;
  state.lastStderr = '';
  state.releaseUnverified = false;
}

export function clearReleaseProgress(state: PaneMemoryState): void {
  clearApplyFailure(state);
  state.desiredKey = '';
}

function armDesired(state: PaneMemoryState, args: string[]): void {
  const desiredKey = args.join('\0');
  if (desiredKey !== state.desiredKey) resetApplyState(state, desiredKey);
}

function logGiveUp(deviceId: string, state: PaneMemoryState): void {
  if (state.giveUpLogged) return;
  state.giveUpLogged = true;
  const stderr = state.lastStderr || 'exit';
  console.warn(
    `[vibeterm][window-memory] set-property giving up device=${deviceId} pane=${state.paneId} scope=${state.scope}: ${stderr}`
  );
}

function noteReleaseUnverified(state: PaneMemoryState, now: number, deviceId: string): void {
  if (!state.releaseUnverified) return;
  state.releaseUnverified = false;
  state.applyAttempts += 1;
  state.applyFailedAt = now;
  state.lastStderr = 'exit 0 but sample still limited';
  console.warn(
    `[vibeterm][window-memory] release still limited device=${deviceId} pane=${state.paneId} scope=${state.scope}: ${state.lastStderr}`
  );
}

export function decideApply(
  state: PaneMemoryState,
  settings: WindowMemorySettings,
  now: number
): PlannedWrite | null {
  const scope = state.scope;
  if (!scope || !state.sample) return null;
  const args = buildSetPropertyArgs(scope, settings);
  if (!args || !needsApply(settings, state.sample)) return null;
  armDesired(state, args);
  if (!canRetryApply(state, now, 'apply')) return null;
  return { state, args, kind: 'apply' };
}

export function decideRelease(
  state: PaneMemoryState,
  triples: readonly AppliedLimitTriple[],
  now: number,
  deviceId: string
): PlannedWrite | null {
  const scope = state.scope;
  const sample = state.sample;
  if (!scope || !sample || !observedLimited(sample) || !observedMatchesAny(sample, triples)) {
    clearReleaseProgress(state);
    return null;
  }
  noteReleaseUnverified(state, now, deviceId);
  const args = buildReleasePropertyArgs(scope);
  armDesired(state, args);
  if (!canRetryApply(state, now, 'release')) return null;
  return { state, args, kind: 'release' };
}

export function recordPropertyResult(result: {
  state: PaneMemoryState;
  kind: 'apply' | 'release';
  code: number;
  stderr: string;
  now: number;
  deviceId: string;
}): void {
  const { state, kind, code, now, deviceId } = result;
  if (code === 0) {
    if (kind === 'release') {
      state.releaseUnverified = true;
      if (state.sample) state.sample.managed = false;
      return;
    }
    clearApplyFailure(state);
    if (state.sample) state.sample.managed = true;
    return;
  }
  // 释放的 124 记两次，退避跳过一档。套限额的 124 只记一次：两次才放弃，一次超时不能把重试用光。
  const bump = code === 124 && kind === 'release' ? 2 : 1;
  state.applyAttempts += bump;
  state.applyFailedAt = now;
  state.releaseUnverified = false;
  state.lastStderr = result.stderr || `exit ${code}`;
  console.warn(
    `[vibeterm][window-memory] set-property failed device=${deviceId} pane=${state.paneId} scope=${state.scope}: ${state.lastStderr}`
  );
  if (kind === 'apply' && state.applyAttempts >= 2) logGiveUp(deviceId, state);
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
