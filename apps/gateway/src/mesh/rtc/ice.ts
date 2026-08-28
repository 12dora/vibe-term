import {
  decodeBase64url,
  encodeBase64url,
  randomBytes,
  signEd25519,
  verifyEd25519,
} from '@tmex/shared/auth';
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

export const RTC_WAKE_TYPE = 'rtc.wake';
export const RTC_WAKE_DOMAIN = 'tmex-rtc-wake';
export const RTC_WAKE_MAX_SKEW_MS = 60_000;
export const RTC_WAKE_NONCE_BYTES = 16;

export type RtcWakeFields = {
  type: typeof RTC_WAKE_TYPE;
  domain: typeof RTC_WAKE_DOMAIN;
  from: string;
  to: string;
  rtcSession: string;
  nonce: string;
  issued_at: number;
  sig: string;
};

export type RtcWakeSignInput = {
  from: string;
  to: string;
  rtcSession: string;
  nonce: string;
  issued_at: number;
};

export function rtcWakeCanonicalBytes(fields: RtcWakeSignInput): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      domain: RTC_WAKE_DOMAIN,
      from: fields.from,
      to: fields.to,
      rtcSession: fields.rtcSession,
      nonce: fields.nonce,
      issued_at: fields.issued_at,
    })
  );
}

export function encodeRtcWakeSdp(opts: {
  from: string;
  to: string;
  rtcSession: string;
  issuedAt: number;
  secretKey: Uint8Array;
  nonce?: Uint8Array;
}): string {
  const nonce = encodeBase64url(opts.nonce ?? randomBytes(RTC_WAKE_NONCE_BYTES));
  const issued_at = opts.issuedAt;
  const canonical = rtcWakeCanonicalBytes({
    from: opts.from,
    to: opts.to,
    rtcSession: opts.rtcSession,
    nonce,
    issued_at,
  });
  const payload: RtcWakeFields = {
    type: RTC_WAKE_TYPE,
    domain: RTC_WAKE_DOMAIN,
    from: opts.from,
    to: opts.to,
    rtcSession: opts.rtcSession,
    nonce,
    issued_at,
    sig: encodeBase64url(signEd25519(opts.secretKey, canonical)),
  };
  return JSON.stringify(payload);
}

export function parseRtcWakeSdp(sdp: string | null | undefined): RtcWakeFields | null {
  if (!sdp) return null;
  try {
    const parsed = JSON.parse(sdp) as Record<string, unknown>;
    if (parsed.type !== RTC_WAKE_TYPE || parsed.sdp !== undefined) return null;
    if (parsed.domain !== RTC_WAKE_DOMAIN) return null;
    if (typeof parsed.from !== 'string' || typeof parsed.to !== 'string') return null;
    if (typeof parsed.rtcSession !== 'string' || typeof parsed.nonce !== 'string') return null;
    if (typeof parsed.issued_at !== 'number' || !Number.isFinite(parsed.issued_at)) return null;
    if (typeof parsed.sig !== 'string') return null;
    return {
      type: RTC_WAKE_TYPE,
      domain: RTC_WAKE_DOMAIN,
      from: parsed.from,
      to: parsed.to,
      rtcSession: parsed.rtcSession,
      nonce: parsed.nonce,
      issued_at: parsed.issued_at,
      sig: parsed.sig,
    };
  } catch {
    return null;
  }
}

export function isRtcWakeSdp(sdp: string | null | undefined): boolean {
  if (!sdp) return false;
  try {
    const parsed = JSON.parse(sdp) as { type?: unknown; sdp?: unknown };
    return parsed.type === RTC_WAKE_TYPE && parsed.sdp === undefined;
  } catch {
    return false;
  }
}

export function verifyRtcWakeSignature(wake: RtcWakeFields, edPk: Uint8Array): boolean {
  try {
    const sig = decodeBase64url(wake.sig);
    if (sig.byteLength !== 64) return false;
    return verifyEd25519(
      sig,
      rtcWakeCanonicalBytes({
        from: wake.from,
        to: wake.to,
        rtcSession: wake.rtcSession,
        nonce: wake.nonce,
        issued_at: wake.issued_at,
      }),
      edPk
    );
  } catch {
    return false;
  }
}

const CANDIDATE_TYPE_RE = /\btyp\s+(host|srflx|prflx|relay)\b/i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;
const IPV4_HOST_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV4_MAPPED_RE = /^(?:(?:0{0,4}:)*:?|::)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function parseIceCandidateType(candidate: string): string | null {
  const match = CANDIDATE_TYPE_RE.exec(candidate);
  return match?.[1]?.toLowerCase() ?? null;
}

function maskIpv4Host(host: string): string {
  const parts = host.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

function maskIpv6Host(host: string): string {
  const mapped = IPV4_MAPPED_RE.exec(host);
  if (mapped?.[1]) return `::ffff:${maskIpv4Host(mapped[1])}`;
  const parts = host.split(':').filter((part) => part.length > 0);
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}:${parts[2]}::`;
  if (parts.length === 2) return `${parts[0]}:${parts[1]}::`;
  if (parts.length === 1) return `${parts[0]}::`;
  return host;
}

function splitIceHostPort(addr: string): { host: string; port: string | null; bracketed: boolean } {
  const trimmed = addr.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end > 0) {
      const host = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1);
      const port = rest.startsWith(':') && rest.length > 1 ? rest.slice(1) : null;
      return { host, port, bracketed: true };
    }
  }
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(trimmed);
  if (v4port?.[1] && v4port[2]) {
    return { host: v4port[1], port: v4port[2], bracketed: false };
  }
  return { host: trimmed, port: null, bracketed: false };
}

export function maskIceAddress(addr: string): string {
  const { host, port, bracketed } = splitIceHostPort(addr);
  let masked: string;
  if (IPV4_HOST_RE.test(host)) masked = maskIpv4Host(host);
  else if (host.includes(':')) masked = maskIpv6Host(host);
  else masked = host;
  if (bracketed) return port ? `[${masked}]:${port}` : `[${masked}]`;
  return port ? `${masked}:${port}` : masked;
}

export function maskIceCandidate(candidate: string): string {
  return candidate
    .replace(IPV4_RE, (ip) => maskIceAddress(ip))
    .replace(IPV6_RE, (ip) => maskIceAddress(ip));
}

export type RtcSignaling = {
  send: (msg: RtcSignalMessage) => void;
  onMessage: (cb: (msg: RtcSignalMessage) => void) => () => void;
};
