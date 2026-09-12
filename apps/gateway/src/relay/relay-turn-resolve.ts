import { isIP } from 'node:net';
import { BUILTIN_STUN_SERVERS } from '@vibeterm/shared/net';
import { type StunProbeDeps, probeStunServer } from '../mesh/rtc/stun-probe';
import {
  STUN_RESOLVE_BUDGET_MS,
  type StunResolveOptions,
  formatHostForIceUrl,
  resolveIceServers,
  stunResolveSnapshot,
} from '../mesh/rtc/stun-resolver';
import { isFakeIp } from '../tunnel/edge-resolver';
import { ipv4FromMappedAddress } from './relay-turn-config';

export type TurnHostResolver = (host: string) => Promise<string | null>;
export type TurnStunProbe = (url: string) => Promise<{ ok: boolean; mappedAddress?: string }>;

export type ResolveTurnExternalIpInput = {
  overrideIp: string | null | undefined;
  advertisedHost: string;
  resolveHost?: TurnHostResolver;
  probeStun?: TurnStunProbe;
  stunServers?: readonly string[];
  resolveOpts?: StunResolveOptions;
  probeDeps?: StunProbeDeps;
};

export type ResolveTurnExternalIpResult = {
  ip: string | null;
  via: 'override' | 'dns' | 'stun' | null;
  error: string | null;
};

export function usableTurnIpv4(ip: string | null | undefined): string | null {
  if (!ip || isIP(ip) !== 4 || isFakeIp(ip)) return null;
  return ip;
}

export async function resolveAdvertisedHostIpv4(
  host: string,
  opts: StunResolveOptions = {}
): Promise<string | null> {
  const literal = usableTurnIpv4(host);
  if (literal) return literal;
  if (isIP(host) !== 0) return null;
  await resolveIceServers([`stun:${formatHostForIceUrl(host)}:3478`], {
    ...opts,
    budgetMs: opts.budgetMs ?? STUN_RESOLVE_BUDGET_MS,
  });
  const records = stunResolveSnapshot();
  const want = host.trim().toLowerCase();
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || rec.host.trim().toLowerCase() !== want) continue;
    const ip = usableTurnIpv4(rec.ip);
    if (ip) return ip;
  }
  return null;
}

async function mappedIpv4FromStun(
  servers: readonly string[],
  probe: TurnStunProbe
): Promise<string | null> {
  for (const url of servers) {
    const result = await probe(url);
    if (!result.ok) continue;
    const ip = usableTurnIpv4(ipv4FromMappedAddress(result.mappedAddress));
    if (ip) return ip;
  }
  return null;
}

export async function resolveTurnExternalIp(
  input: ResolveTurnExternalIpInput
): Promise<ResolveTurnExternalIpResult> {
  const override = usableTurnIpv4(input.overrideIp ?? null);
  if (override) return { ip: override, via: 'override', error: null };

  const resolveHost =
    input.resolveHost ?? ((host) => resolveAdvertisedHostIpv4(host, input.resolveOpts));
  const fromDns = usableTurnIpv4(await resolveHost(input.advertisedHost));
  if (fromDns) return { ip: fromDns, via: 'dns', error: null };

  const probe =
    input.probeStun ??
    (async (url) => {
      const result = await probeStunServer(url, input.probeDeps);
      return { ok: result.ok, mappedAddress: result.mappedAddress };
    });
  const fromStun = await mappedIpv4FromStun(input.stunServers ?? BUILTIN_STUN_SERVERS, probe);
  if (fromStun) return { ip: fromStun, via: 'stun', error: null };

  return {
    ip: null,
    via: null,
    error: `unable to resolve TURN external IPv4 for host=${input.advertisedHost}`,
  };
}
