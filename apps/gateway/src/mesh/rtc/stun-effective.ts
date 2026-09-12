import {
  type StunEffectiveSource,
  type StunEnvConfig,
  type StunEnvSource,
  resolveEffectiveStun,
} from '@vibeterm/shared/net';
import type { RelayTurnConfig } from '@vibeterm/shared/relay';
import type { CachedRtcConfig } from '../mesh-deps';
import { rtcLog } from './rtc-log';
import {
  type StunProbeRecord,
  type StunProbeRtc,
  type StunProbeScheduler,
  rankStunByProbes,
  startMeshStunProbe,
  stopMeshStunProbe,
  stunProbeSnapshot,
  syncStunProbe,
  withStunProbes,
} from './stun-probe';
import {
  type TurnProbeRecord,
  type TurnProbeRtc,
  configuredTurnUrls,
  flattenTurnConfigs,
  startMeshTurnProbe,
  stopMeshTurnProbe,
  syncTurnProbe,
  turnProbeSnapshot,
  turnUrlOf,
} from './turn-probe';

export const MAX_GATED_TURN = 2;

export type MeshStunConfig = {
  stunServers: string[];
  stunSource?: StunEnvSource;
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
};

export type ResolvedMeshRtcConfig = {
  stun: string[];
  turn: RelayTurnConfig[];
  turnConfigured: RelayTurnConfig[];
  turnProbeOk: boolean;
  source: StunEffectiveSource;
};

export type MeshRtcConfigBody = Omit<CachedRtcConfig, 'turn'> & {
  turn: RelayTurnConfig[];
  turnConfigured: RelayTurnConfig[];
  turnProbe: TurnProbeRecord | null;
  turnProbes: TurnProbeRecord[];
};

export function localStunEnv(config: MeshStunConfig): StunEnvConfig {
  if (config.stunSource) return { servers: [...config.stunServers], source: config.stunSource };
  return {
    servers: [...config.stunServers],
    source: config.stunServers.length > 0 ? 'custom' : 'disabled',
  };
}

export function turnFromMesh(config: MeshStunConfig): CachedRtcConfig['turn'] {
  if (config.turnUrl && config.turnUsername && config.turnCredential) {
    return {
      url: config.turnUrl,
      username: config.turnUsername,
      credential: config.turnCredential,
    };
  }
  return null;
}

export function matchingTurnProbe(
  configured: unknown,
  probes: readonly TurnProbeRecord[] = turnProbeSnapshot()
): TurnProbeRecord | null {
  const url = turnUrlOf(configured);
  if (!url) return null;
  for (let i = probes.length - 1; i >= 0; i--) {
    const row = probes[i];
    if (row?.url === url) return row;
  }
  return null;
}

/** 探测成功才纳入 TURN；未探测或失败一律排除，按 RTT 升序最多 2 条。 */
export function gateTurnByProbe(
  configured: unknown,
  probes: readonly TurnProbeRecord[] = turnProbeSnapshot()
): { turn: RelayTurnConfig[]; turnProbeOk: boolean } {
  const entries = flattenTurnConfigs(configured);
  const turn = pickReachableTurns(entries, probes);
  logTurnGate(entries.length, turn);
  return { turn, turnProbeOk: turn.length > 0 };
}

export function resetTurnGateLogForTest(): void {
  lastTurnGateUsedKey = null;
}

let lastTurnGateUsedKey: string | null = null;

function latestProbeByUrl(probes: readonly TurnProbeRecord[]): Map<string, TurnProbeRecord> {
  const map = new Map<string, TurnProbeRecord>();
  for (const row of probes) map.set(row.url, row);
  return map;
}

function pickReachableTurns(
  entries: readonly RelayTurnConfig[],
  probes: readonly TurnProbeRecord[]
): RelayTurnConfig[] {
  const latest = latestProbeByUrl(probes);
  const ranked: Array<{ entry: RelayTurnConfig; rttMs: number; index: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const probe = latest.get(entry.url);
    if (!probe?.ok) continue;
    ranked.push({ entry, rttMs: probe.rttMs, index: i });
  }
  ranked.sort((a, b) => a.rttMs - b.rttMs || a.index - b.index);
  return ranked.slice(0, MAX_GATED_TURN).map((row) => row.entry);
}

function logTurnGate(configured: number, used: readonly RelayTurnConfig[]): void {
  const key = used.map((row) => row.url).join('\0');
  if (key === lastTurnGateUsedKey) return;
  lastTurnGateUsedKey = key;
  rtcLog('turn gate', {
    configured,
    reachable: used.length,
    used: used.map((row) => row.url),
  });
}

function turnProbesForConfigured(
  configured: unknown,
  probes: readonly TurnProbeRecord[] = turnProbeSnapshot()
): TurnProbeRecord[] {
  const latest = latestProbeByUrl(probes);
  const out: TurnProbeRecord[] = [];
  for (const url of configuredTurnUrls(configured)) {
    const row = latest.get(url);
    if (row) out.push(row);
  }
  return out;
}

export function resolveMeshRtcConfig(
  config: MeshStunConfig,
  lastRtc: CachedRtcConfig | null,
  probes: readonly StunProbeRecord[] = stunProbeSnapshot(),
  now: number = Date.now()
): ResolvedMeshRtcConfig {
  const resolved = resolveEffectiveStun({
    local: localStunEnv(config),
    distributed: lastRtc?.stun ?? null,
  });
  const turnConfigured = flattenTurnConfigs(lastRtc ? lastRtc.turn : turnFromMesh(config));
  const gated = gateTurnByProbe(turnConfigured);
  return {
    stun: rankStunByProbes(resolved.stun, probes, now),
    turn: gated.turn,
    turnConfigured,
    turnProbeOk: gated.turnProbeOk,
    source: resolved.source,
  };
}

export function meshRtcConfigResponse(
  config: MeshStunConfig,
  lastRtc: CachedRtcConfig | null
): MeshRtcConfigBody {
  const resolved = resolveMeshRtcConfig(config, lastRtc);
  const withProbes = withStunProbes({ stun: resolved.stun, turn: resolved.turn });
  return {
    stun: withProbes.stun,
    turn: resolved.turn,
    probes: withProbes.probes,
    source: resolved.source,
    turnConfigured: resolved.turnConfigured,
    turnProbe: matchingTurnProbe(resolved.turnConfigured),
    turnProbes: turnProbesForConfigured(resolved.turnConfigured),
  };
}

export function listedStun(stun: readonly string[], source?: StunEnvSource): string[] {
  const resolved = source ?? (stun.length > 0 ? 'custom' : 'builtin');
  return resolved === 'custom' ? [...stun] : [];
}

export function logMeshStunConfig(
  resolved: { source: StunEffectiveSource; stun: readonly string[] },
  previousKey: string | null
): string {
  const key = `${resolved.source}\0${resolved.stun.join(',')}`;
  if (key === previousKey) return key;
  rtcLog('stun config', {
    source: resolved.source,
    count: resolved.stun.length,
    list: resolved.stun.join(','),
  });
  return key;
}

export function noteMeshStunConfig(
  state: { lastRtc: CachedRtcConfig | null; lastStunLogKey: string | null },
  config: MeshStunConfig
): void {
  state.lastStunLogKey = logMeshStunConfig(
    resolveMeshRtcConfig(config, state.lastRtc),
    state.lastStunLogKey
  );
}

type MeshRtcProbe = StunProbeRtc & TurnProbeRtc;

export function startMeshRtcProbes(rtc: MeshRtcProbe, scheduler: StunProbeScheduler): void {
  startMeshStunProbe(rtc, scheduler);
  startMeshTurnProbe(rtc, scheduler);
}

export function stopMeshRtcProbes(after?: () => void): void {
  stopMeshStunProbe();
  stopMeshTurnProbe(after);
}

export function syncMeshRtcProbes(rtc: MeshRtcProbe): void {
  syncStunProbe(rtc);
  syncTurnProbe(rtc);
}
