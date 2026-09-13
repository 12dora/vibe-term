import type { RelayTurnConfig } from '@vibeterm/shared/relay';
import { logAt } from '../../log/level';
import { stamp } from '../mesh-log';
import { flattenTurnConfigs } from './turn-config';
import type { TurnProbeRecord } from './turn-probe';

/** libjuice `MAX_RELAY_ENTRIES_COUNT`；多出来的 TURN 进不了 ICE。 */
export const MAX_TURN_ICE_ENTRIES = 2;

export type TurnIceProbe = Pick<TurnProbeRecord, 'url' | 'ok' | 'rttMs'>;

type RankedTurn = {
  entry: RelayTurnConfig;
  probeOk: number;
  rttMs: number;
  primary: number;
  index: number;
};

let lastPickKey: string | null = null;

export function resetTurnIcePickLogForTest(): void {
  lastPickKey = null;
}

/**
 * 拨号时按探测结果挑 ≤2 条 TURN。列表顺序约定来自 `mergeListedRtc`：
 * 主中继在前，其余按 priority / 插入序；未探测时保持该序。
 */
export function pickTurnForIce(
  turn: unknown,
  probes?: readonly TurnIceProbe[],
  max = MAX_TURN_ICE_ENTRIES
): unknown {
  if (turn == null) return turn;
  const entries = flattenTurnConfigs(turn);
  if (entries.length === 0) return turn;
  const picked = rankTurnIceEntries(entries, probes ?? []).slice(0, max);
  logTurnIcePick(
    picked.map((row) => row.url),
    Math.max(0, entries.length - picked.length)
  );
  return picked;
}

export function rankTurnIceEntries(
  entries: readonly RelayTurnConfig[],
  probes: readonly TurnIceProbe[]
): RelayTurnConfig[] {
  const latest = new Map<string, TurnIceProbe>();
  for (const row of probes) latest.set(row.url, row);
  return entries
    .map((entry, index) => rankRow(entry, index, latest.get(entry.url)))
    .sort(compareTurnIceRank)
    .map((row) => row.entry);
}

function rankRow(
  entry: RelayTurnConfig,
  index: number,
  probe: TurnIceProbe | undefined
): RankedTurn {
  const ok = probe?.ok === true;
  return {
    entry,
    probeOk: ok ? 1 : 0,
    rttMs: probe?.ok === true ? probe.rttMs : Number.POSITIVE_INFINITY,
    primary: index === 0 ? 1 : 0,
    index,
  };
}

function compareTurnIceRank(a: RankedTurn, b: RankedTurn): number {
  if (a.probeOk !== b.probeOk) return b.probeOk - a.probeOk;
  if (a.probeOk !== 0 && a.rttMs !== b.rttMs) return a.rttMs - b.rttMs;
  if (a.primary !== b.primary) return b.primary - a.primary;
  return a.index - b.index;
}

function logTurnIcePick(urls: readonly string[], dropped: number): void {
  const key = `${urls.join(',')}\0${dropped}`;
  if (key === lastPickKey) return;
  lastPickKey = key;
  logAt(
    'info',
    stamp(`[mesh][rtc] turn pick urls=${urls.join(',')} dropped=${dropped} by=probe-rtt`)
  );
}
