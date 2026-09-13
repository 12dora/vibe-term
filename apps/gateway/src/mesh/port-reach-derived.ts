import {
  DEFAULT_PUBLIC_HTTPS_PORT,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  type PortRange,
  parseProbeTarget,
} from '@vibeterm/shared/net';
import { config as gatewayConfig } from '../config';
import type { MeshPortReach } from './node-list-projection';

type TurnMembersSnap = { ok: number; total: number; updatedAt: number };

export type SelfPortRoles = { hub: boolean; relay: boolean };

export function derivedSelfPortRows(input: {
  roles: SelfPortRoles;
  httpsUplink: boolean;
  httpsCheckedAt?: number;
  turn: TurnMembersSnap | null;
}): MeshPortReach[] {
  const rows: MeshPortReach[] = [];
  if (input.roles.hub || input.roles.relay) {
    rows.push(publicHttpsRow(input.httpsUplink, input.httpsCheckedAt));
  }
  if (input.roles.relay && gatewayConfig.turnPort !== 0) {
    const turn = turnControlRow(input.turn);
    rows.push(turn, turnRelayRow(turn));
  }
  return rows;
}

export function selfHttpsPort(): number {
  const url = gatewayConfig.roles.relay
    ? gatewayConfig.relayPublicUrl
    : (gatewayConfig.hubPublicUrl ?? gatewayConfig.hubUrl);
  return parseHttpsPort(url) ?? DEFAULT_PUBLIC_HTTPS_PORT;
}

export function localTurnPort(): number {
  return gatewayConfig.turnPort || DEFAULT_TURN_PORT;
}

export function localTurnRelayRange(): PortRange {
  const live = gatewayConfig.turnRelayPortRange;
  return live ? { begin: live.begin, end: live.end } : { ...DEFAULT_TURN_RELAY_PORT_RANGE };
}

export function localRelaySnapshotKey(): string | undefined {
  const url = gatewayConfig.relayPublicUrl?.trim();
  return url || undefined;
}

function parseHttpsPort(url: string | null | undefined): number | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const target = parseProbeTarget(raw);
    if (target.explicitPort !== null) return target.explicitPort;
    if (target.protocol === 'https:') return DEFAULT_PUBLIC_HTTPS_PORT;
    return target.port;
  } catch {
    return null;
  }
}

function publicHttpsRow(uplinked: boolean, checkedAt?: number): MeshPortReach {
  return {
    purpose: 'public-https',
    proto: 'tcp',
    port: selfHttpsPort(),
    status: uplinked ? 'open' : 'unknown',
    ...(checkedAt ? { checkedAt } : {}),
  };
}

function turnControlRow(snap: TurnMembersSnap | null): MeshPortReach {
  const port = localTurnPort();
  if (!snap) {
    return { purpose: 'turn-control', proto: 'udp', port, status: 'unknown' };
  }
  if (snap.ok > 0) {
    return {
      purpose: 'turn-control',
      proto: 'udp',
      port,
      status: 'open',
      checkedAt: snap.updatedAt,
    };
  }
  if (snap.total >= 2) {
    return {
      purpose: 'turn-control',
      proto: 'udp',
      port,
      status: 'blocked',
      code: 'turn_probe_failed',
      checkedAt: snap.updatedAt,
    };
  }
  return {
    purpose: 'turn-control',
    proto: 'udp',
    port,
    status: 'unknown',
    checkedAt: snap.updatedAt,
  };
}

function turnRelayRow(control: MeshPortReach): MeshPortReach {
  const code = control.status === 'blocked' ? 'turn_probe_failed' : 'not_probed';
  return {
    purpose: 'turn-relay',
    proto: 'udp',
    range: localTurnRelayRange(),
    status: control.status,
    code,
    ...(control.checkedAt ? { checkedAt: control.checkedAt } : {}),
  };
}
