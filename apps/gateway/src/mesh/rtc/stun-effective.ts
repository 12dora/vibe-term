import {
  type StunEffectiveSource,
  type StunEnvConfig,
  type StunEnvSource,
  resolveEffectiveStun,
} from '@vibeterm/shared/net';
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
  startMeshTurnProbe,
  stopMeshTurnProbe,
  syncTurnProbe,
  turnProbeSnapshot,
  turnUrlOf,
} from './turn-probe';

export type MeshStunConfig = {
  stunServers: string[];
  stunSource?: StunEnvSource;
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
};

export type ResolvedMeshRtcConfig = {
  stun: string[];
  turn: unknown;
  turnConfigured: unknown;
  turnProbeOk: boolean;
  source: StunEffectiveSource;
};

export type MeshRtcConfigBody = CachedRtcConfig & {
  turnConfigured: unknown;
  turnProbe: TurnProbeRecord | null;
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

/** 探测成功才纳入 TURN；从未探测则先纳入但 turnProbeOk=false（保持 mux）。 */
export function gateTurnByProbe(
  configured: unknown,
  probes: readonly TurnProbeRecord[] = turnProbeSnapshot()
): { turn: unknown; turnProbeOk: boolean } {
  if (!configured) return { turn: null, turnProbeOk: false };
  const probe = matchingTurnProbe(configured, probes);
  if (!probe) return { turn: configured, turnProbeOk: false };
  if (probe.ok) return { turn: configured, turnProbeOk: true };
  return { turn: null, turnProbeOk: false };
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
  const turnConfigured = lastRtc ? lastRtc.turn : turnFromMesh(config);
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
  return {
    ...withStunProbes({ stun: resolved.stun, turn: resolved.turn }),
    source: resolved.source,
    turnConfigured: resolved.turnConfigured,
    turnProbe: matchingTurnProbe(resolved.turnConfigured),
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
