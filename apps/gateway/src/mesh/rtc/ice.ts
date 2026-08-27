import type { RtcSignalMessage } from '../mesh-deps';
import type { IceRelayType, IceServer, IceServerConfig, RtcIceConfig } from './native';

export type SdpSignal = { type: string; sdp: string };
export type CandidateSignal = { candidate: string; mid: string };

const DEFAULT_TURN_PORT = 3478;
const DEFAULT_TURNS_PORT = 5349;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function relayTypeFor(scheme: string, transport: string | undefined): IceRelayType {
  if (scheme === 'turns' || scheme === 'stuns') return 'TurnTls';
  if (transport === 'tcp') return 'TurnTcp';
  return 'TurnUdp';
}

function splitHostPort(hostport: string): { hostname: string; port: number | null } {
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']');
    if (end < 0) return { hostname: hostport, port: null };
    const hostname = hostport.slice(1, end);
    const rest = hostport.slice(end + 1);
    if (rest.startsWith(':')) {
      const port = Number(rest.slice(1));
      return { hostname, port: Number.isFinite(port) ? port : null };
    }
    return { hostname, port: null };
  }
  const colon = hostport.lastIndexOf(':');
  if (colon > 0 && hostport.indexOf(':') === colon) {
    const port = Number(hostport.slice(colon + 1));
    if (Number.isFinite(port)) return { hostname: hostport.slice(0, colon), port };
  }
  return { hostname: hostport, port: null };
}

export function parseTurnUri(url: string): IceServer | null {
  const trimmed = url.trim();
  const q = trimmed.indexOf('?');
  const base = q >= 0 ? trimmed.slice(0, q) : trimmed;
  const query = q >= 0 ? trimmed.slice(q + 1) : '';
  const match = /^(turns?|stuns?):(.+)$/i.exec(base);
  if (!match?.[1] || !match[2]) return null;
  const scheme = match[1].toLowerCase();
  const { hostname, port: parsedPort } = splitHostPort(match[2]);
  if (!hostname) return null;
  const params = new URLSearchParams(query);
  const transport = params.get('transport')?.toLowerCase() ?? undefined;
  const defaultPort =
    scheme === 'turns' || scheme === 'stuns' ? DEFAULT_TURNS_PORT : DEFAULT_TURN_PORT;
  return {
    hostname,
    port: parsedPort ?? defaultPort,
    relayType: relayTypeFor(scheme, transport),
  };
}

function credentialsOf(rec: Record<string, unknown>): { username?: string; password?: string } {
  const username = typeof rec.username === 'string' ? rec.username : undefined;
  const password =
    typeof rec.password === 'string'
      ? rec.password
      : typeof rec.credential === 'string'
        ? rec.credential
        : undefined;
  return { username, password };
}

function withCredentials(server: IceServer, rec: Record<string, unknown>): IceServer {
  const { username, password } = credentialsOf(rec);
  return {
    ...server,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

function fromStructured(rec: Record<string, unknown>): IceServer | null {
  if (typeof rec.hostname !== 'string' || rec.hostname.length === 0) return null;
  const port =
    typeof rec.port === 'number' && Number.isFinite(rec.port) ? rec.port : DEFAULT_TURN_PORT;
  const relayType =
    rec.relayType === 'TurnUdp' || rec.relayType === 'TurnTcp' || rec.relayType === 'TurnTls'
      ? rec.relayType
      : undefined;
  return withCredentials(
    {
      hostname: rec.hostname,
      port,
      ...(relayType ? { relayType } : {}),
    },
    rec
  );
}

function fromUrl(url: string, rec?: Record<string, unknown>): string | IceServer {
  const parsed = parseTurnUri(url);
  if (!parsed) return url;
  if (!rec) return parsed.relayType ? parsed : url;
  const creds = credentialsOf(rec);
  if (!creds.username && !creds.password) return url;
  return withCredentials(parsed, rec);
}

function collectTurnEntry(value: unknown): Array<string | IceServer> {
  if (typeof value === 'string') return [fromUrl(value)];
  if (Array.isArray(value)) {
    const out: Array<string | IceServer> = [];
    for (const item of value) out.push(...collectTurnEntry(item));
    return out;
  }
  if (!isRecord(value)) return [];
  const structured = fromStructured(value);
  if (structured) return [structured];
  const urls: string[] = [];
  if (typeof value.url === 'string') urls.push(value.url);
  else if (typeof value.urls === 'string') urls.push(value.urls);
  else if (Array.isArray(value.urls)) {
    for (const url of value.urls) {
      if (typeof url === 'string') urls.push(url);
    }
  }
  return urls.map((url) => fromUrl(url, value));
}

export function collectIceServers(cfg: IceServerConfig): Array<string | IceServer> {
  const servers: Array<string | IceServer> = [...cfg.stun];
  if (!cfg.turn) return servers;
  servers.push(...collectTurnEntry(cfg.turn));
  return servers;
}

export function buildRtcIceConfig(cfg: IceServerConfig): RtcIceConfig {
  return { iceServers: collectIceServers(cfg) };
}

export function encodeSdpSignal(desc: SdpSignal): string {
  return JSON.stringify(desc);
}

export function decodeSdpSignal(raw: string): SdpSignal | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; sdp?: unknown };
      if (typeof parsed.type === 'string' && typeof parsed.sdp === 'string') {
        return { type: parsed.type, sdp: parsed.sdp };
      }
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('v=')) return { type: 'offer', sdp: raw };
  return null;
}

export function encodeCandidateSignal(candidate: string, mid: string): string {
  return JSON.stringify({ candidate, mid });
}

export function decodeCandidateSignal(raw: string): CandidateSignal | null {
  try {
    const parsed = JSON.parse(raw) as { candidate?: unknown; mid?: unknown };
    if (typeof parsed.candidate === 'string') {
      return {
        candidate: parsed.candidate,
        mid: typeof parsed.mid === 'string' ? parsed.mid : '0',
      };
    }
  } catch {
    const nl = raw.indexOf('\n');
    if (nl > 0) return { mid: raw.slice(0, nl), candidate: raw.slice(nl + 1) };
    if (raw) return { candidate: raw, mid: '0' };
  }
  return null;
}

export function peerRtcSession(a: string, b: string): string {
  const lo = a.toLowerCase() <= b.toLowerCase() ? a.toLowerCase() : b.toLowerCase();
  const hi = a.toLowerCase() <= b.toLowerCase() ? b.toLowerCase() : a.toLowerCase();
  return `dc:${lo}:${hi}`;
}

export function isEmptyCandidate(candidate: string): boolean {
  return candidate.trim().length === 0;
}

export type RtcSignaling = {
  send: (msg: RtcSignalMessage) => void;
  onMessage: (cb: (msg: RtcSignalMessage) => void) => void;
};
