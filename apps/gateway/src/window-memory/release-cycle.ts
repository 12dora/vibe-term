// 采样之后的写限额：活 pane 与孤儿合成一次 set-property。
// 孤儿清扫只在进入释放、或设置变了的那一拍立刻跑，之后最多 60s 一次。

import type { WindowMemorySettings } from '@vibeterm/shared';

import type { AppliedTripleBook } from './applied-triples';
import { ORPHAN_SWEEP_INTERVAL_MS } from './constants';
import { sweepReleaseOrphans } from './orphan-scopes';
import { runPropertyBatch } from './property-batch';
import { isAllZeroLimits } from './scope-commands';
import { type PaneMemoryState, type PlannedWrite, decideApply, decideRelease } from './tracker-ops';
import type { MemoryPaneRef } from './tracker-ops';
import type { HostShellRunner } from './types';

export interface SweepClock {
  lastAt: number;
  forced: boolean;
  releaseKey: string;
}

export interface MemoryMutationInput {
  host: HostShellRunner;
  deviceId: string;
  now: number;
  settings: WindowMemorySettings;
  panes: readonly MemoryPaneRef[];
  paneStates: Map<string, PaneMemoryState>;
  orphanStates: Map<string, PaneMemoryState>;
  orphanWarn: Set<string>;
  limitsSupported: boolean | null;
  cgroupPinned: boolean;
  sampleReason: string | undefined;
  sawTmuxSpawn: boolean;
  book: AppliedTripleBook;
  sweep: SweepClock;
}

export async function runMemoryMutations(input: MemoryMutationInput): Promise<void> {
  input.book.remember(input.settings);
  const release = releaseMode(input.settings);
  const live = planPaneWrites(input, release);
  const orphans = await planOrphanWrites(input, release);
  await runPropertyBatch(input.host, input.deviceId, [...live, ...orphans], input.now);
}

function releaseMode(settings: WindowMemorySettings): boolean {
  return !settings.enabled || isAllZeroLimits(settings);
}

function planPaneWrites(input: MemoryMutationInput, release: boolean): PlannedWrite[] {
  if (!release && input.limitsSupported === false) return [];
  const triples = input.book.list();
  const planned: PlannedWrite[] = [];
  for (const state of input.paneStates.values()) {
    const write = release
      ? decideRelease(state, triples, input.now, input.deviceId)
      : decideApply(state, input.settings, input.now);
    if (write) planned.push(write);
  }
  return planned;
}

async function planOrphanWrites(
  input: MemoryMutationInput,
  release: boolean
): Promise<PlannedWrite[]> {
  if (!release) {
    input.orphanStates.clear();
    input.sweep.forced = true;
    input.sweep.releaseKey = '';
    return [];
  }
  armSweep(input);
  if (sweepBlocked(input) || !sweepDue(input)) return [];
  input.sweep.forced = false;
  input.sweep.lastAt = input.now;
  return sweepReleaseOrphans({
    host: input.host,
    deviceId: input.deviceId,
    now: input.now,
    panes: input.panes,
    liveScopes: liveScopeNames(input.paneStates.values()),
    states: input.orphanStates,
    warned: input.orphanWarn,
    triples: input.book.list(),
  });
}

function armSweep(input: MemoryMutationInput): void {
  const key = releaseKeyOf(input.settings);
  if (key === input.sweep.releaseKey) return;
  input.sweep.releaseKey = key;
  input.sweep.forced = true;
}

function releaseKeyOf(settings: WindowMemorySettings): string {
  return [
    settings.enabled,
    settings.memoryHighMb,
    settings.memoryMaxMb,
    settings.memorySwapMaxMb,
  ].join(':');
}

function sweepBlocked(input: MemoryMutationInput): boolean {
  if (input.cgroupPinned) return true;
  if (input.sampleReason === 'no-cgroup2' || input.sampleReason === 'no-user-systemd') return true;
  if (!input.sawTmuxSpawn) return true;
  return input.book.list().length === 0;
}

function sweepDue(input: MemoryMutationInput): boolean {
  if (input.sweep.forced) return true;
  return input.now - input.sweep.lastAt >= ORPHAN_SWEEP_INTERVAL_MS;
}

function liveScopeNames(states: Iterable<PaneMemoryState>): string[] {
  const names: string[] = [];
  for (const state of states) {
    if (state.scope && !names.includes(state.scope)) names.push(state.scope);
  }
  return names;
}
