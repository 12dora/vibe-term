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
  rankStunByProbes,
  stunProbeSnapshot,
  withStunProbes,
} from './stun-probe';

export type MeshStunConfig = {
  stunServers: string[];
  stunSource?: StunEnvSource;
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
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

export function resolveMeshRtcConfig(
  config: MeshStunConfig,
  lastRtc: CachedRtcConfig | null,
  probes: readonly StunProbeRecord[] = stunProbeSnapshot(),
  now: number = Date.now()
): { stun: string[]; turn: unknown; source: StunEffectiveSource } {
  const resolved = resolveEffectiveStun({
    local: localStunEnv(config),
    distributed: lastRtc?.stun ?? null,
  });
  return {
    stun: rankStunByProbes(resolved.stun, probes, now),
    turn: lastRtc?.turn ?? turnFromMesh(config),
    source: resolved.source,
  };
}

export function meshRtcConfigResponse(
  config: MeshStunConfig,
  lastRtc: CachedRtcConfig | null
): CachedRtcConfig {
  const resolved = resolveMeshRtcConfig(config, lastRtc);
  return {
    ...withStunProbes({ stun: resolved.stun, turn: resolved.turn }),
    source: resolved.source,
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
