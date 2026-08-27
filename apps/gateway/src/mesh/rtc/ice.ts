import type { RtcSignalMessage } from '../mesh-deps';
import type { IceServerConfig, RtcIceConfig } from './native';

export type SdpSignal = { type: string; sdp: string };
export type CandidateSignal = { candidate: string; mid: string };

export function collectIceServers(cfg: IceServerConfig): unknown[] {
  const servers: unknown[] = [...cfg.stun];
  const turn = cfg.turn;
  if (!turn) return servers;
  if (typeof turn === 'string') {
    servers.push(turn);
    return servers;
  }
  if (Array.isArray(turn)) {
    for (const item of turn) servers.push(item);
    return servers;
  }
  if (typeof turn === 'object') {
    const rec = turn as Record<string, unknown>;
    if (typeof rec.url === 'string') servers.push(rec.url);
    else if (typeof rec.urls === 'string') servers.push(rec.urls);
    else if (Array.isArray(rec.urls)) {
      for (const url of rec.urls) servers.push(url);
    } else if (typeof rec.hostname === 'string') {
      servers.push(rec);
    }
  }
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
