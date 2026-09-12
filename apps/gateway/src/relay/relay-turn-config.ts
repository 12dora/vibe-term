import { isIP } from 'node:net';
import {
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  parsePortRange,
} from '@vibeterm/shared/net';
import type { RelayRtcConfig } from '@vibeterm/shared/relay';

export { DEFAULT_TURN_PORT, DEFAULT_TURN_RELAY_PORT_RANGE };
export const DEFAULT_TURN_RELAY_PORT_BEGIN = DEFAULT_TURN_RELAY_PORT_RANGE.begin;
export const DEFAULT_TURN_RELAY_PORT_END = DEFAULT_TURN_RELAY_PORT_RANGE.end;
export const DEFAULT_TURN_RELAY_RANGE_TEXT = `${DEFAULT_TURN_RELAY_PORT_BEGIN}-${DEFAULT_TURN_RELAY_PORT_END}`;
export const TURN_REALM = 'vibeterm';
export const TURN_BIND_RETRY_MIN_MS = 5_000;
export const TURN_BIND_RETRY_MAX_MS = 60_000;
export const TURN_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
export const TURN_CREDENTIAL_KV_KEY = 'relay.turn.credentials';

export type TurnPortRange = {
  begin: number;
  end: number;
};

export type TurnSource = 'builtin' | 'external' | 'off';

export type RelayTurnAdvertisement = RelayRtcConfig['turn'];

export type RelayTurnStatus = {
  enabled: boolean;
  source: TurnSource;
  url: string | null;
  port: number | null;
  externalIp: string | null;
  bindHost?: string | null;
  listening: boolean;
  allocations: number;
  error: string | null;
  relayPortRange: string | null;
};

export const EMPTY_RELAY_TURN_STATUS: RelayTurnStatus = {
  enabled: false,
  source: 'off',
  url: null,
  port: null,
  externalIp: null,
  listening: false,
  allocations: 0,
  error: null,
  relayPortRange: null,
};

export function parseTurnPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TURN_PORT;
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === '0') return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error('VIBETERM_TURN_PORT must be a decimal integer, 0, or off');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('VIBETERM_TURN_PORT must be an integer in 1..65535, 0, or off');
  }
  return port;
}

export function parseTurnRelayPortRange(raw: string | undefined): TurnPortRange {
  if (raw === undefined || raw.trim() === '') return { ...DEFAULT_TURN_RELAY_PORT_RANGE };
  const parsed = parsePortRange(raw);
  if (parsed) return parsed;
  if (!/^(\d+)\s*-\s*(\d+)$/.test(raw.trim())) {
    throw new Error('VIBETERM_TURN_RELAY_PORT_RANGE must use begin-end format');
  }
  throw new Error('VIBETERM_TURN_RELAY_PORT_RANGE must be an ordered range within 1..65535');
}

export function parseTurnExternalIp(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (isIP(value) !== 4) {
    throw new Error('VIBETERM_TURN_EXTERNAL_IP must be an IPv4 address');
  }
  return value;
}

export function parseTurnHost(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

export function formatTurnPortRange(range: TurnPortRange): string {
  return `${range.begin}-${range.end}`;
}

/** DNS/STUN 解析输入：显式 TURN_HOST，否则用 public URL 的 hostname。 */
export function turnResolveHost(publicUrl: string, turnHost: string | null | undefined): string {
  const explicit = turnHost?.trim();
  if (explicit) return explicit;
  return new URL(publicUrl).hostname;
}

/** 广告进 turn: URL 的 host：显式 TURN_HOST，否则用已解析的公网 IPv4 字面量。 */
export function advertisedTurnHost(
  turnHost: string | null | undefined,
  externalIp: string
): string {
  const explicit = turnHost?.trim();
  return explicit || externalIp;
}

export function hasExternalTurnTriple(
  url: string | null | undefined,
  username: string | null | undefined,
  credential: string | null | undefined
): boolean {
  return Boolean(url && username && credential);
}

export function decideTurnMode(input: {
  turn?: RelayTurnAdvertisement | null;
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
  turnPort?: number;
}): TurnSource {
  if (input.turn?.url && input.turn.username && input.turn.credential) return 'external';
  if (hasExternalTurnTriple(input.turnUrl, input.turnUsername, input.turnCredential)) {
    return 'external';
  }
  if (input.turnPort === undefined || input.turnPort === 0) return 'off';
  return 'builtin';
}

export function externalTurnFromConfig(input: {
  turn?: RelayTurnAdvertisement | null;
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
}): RelayTurnAdvertisement {
  if (input.turn?.url && input.turn.username && input.turn.credential) return input.turn;
  if (hasExternalTurnTriple(input.turnUrl, input.turnUsername, input.turnCredential)) {
    return {
      url: input.turnUrl as string,
      username: input.turnUsername as string,
      credential: input.turnCredential as string,
    };
  }
  return null;
}

function rangesOverlap(a: TurnPortRange, b: TurnPortRange): boolean {
  return a.begin <= b.end && b.begin <= a.end;
}

function portInRange(port: number, range: TurnPortRange): boolean {
  return port >= range.begin && port <= range.end;
}

export function describeTurnPortConflict(
  listenPort: number,
  relayRange: TurnPortRange,
  rtcRange: TurnPortRange | null | undefined,
  peerPort: number | null | undefined
): string | null {
  if (peerPort != null && peerPort > 0) {
    if (listenPort === peerPort) {
      return `listen port ${listenPort} overlaps VIBETERM_PEER_PORT`;
    }
    if (portInRange(peerPort, relayRange)) {
      return `relay range ${formatTurnPortRange(relayRange)} overlaps VIBETERM_PEER_PORT`;
    }
  }
  if (rtcRange) {
    if (portInRange(listenPort, rtcRange)) {
      return `listen port ${listenPort} overlaps VIBETERM_RTC_PORT_RANGE`;
    }
    if (rangesOverlap(relayRange, rtcRange)) {
      return `relay range ${formatTurnPortRange(relayRange)} overlaps VIBETERM_RTC_PORT_RANGE`;
    }
  }
  return null;
}

export function turnFirewallHint(
  port: number = DEFAULT_TURN_PORT,
  range: string = DEFAULT_TURN_RELAY_RANGE_TEXT
): string {
  return `open UDP ${port} and UDP ${range} on the cloud security group / ufw`;
}

export function parsePortFromTurnUrl(url: string): number | null {
  const match = /:(\d+)(?:\?|$)/.exec(url);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function ipv4FromMappedAddress(mapped: string | undefined): string | null {
  if (!mapped) return null;
  const host = mapped.startsWith('[')
    ? mapped.slice(1, mapped.lastIndexOf(']'))
    : mapped.slice(0, mapped.lastIndexOf(':'));
  return isIP(host) === 4 ? host : null;
}

export function isRetryableBindError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EADDRINUSE'
  );
}

export function bindErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code =
      'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : null;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
