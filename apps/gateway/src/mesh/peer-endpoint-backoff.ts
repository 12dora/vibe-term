import { canonicalPeerHost } from './address-class';
import { isoNow, logLine } from './mesh-log';

export const ENDPOINT_BACKOFF_MIN_MS = 60_000;
export const ENDPOINT_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
export const ENDPOINT_BACKOFF_IDLE_MS = 24 * 60 * 60 * 1000;

export type ReachabilityFailureKind =
  | 'timeout'
  | 'open-timeout'
  | 'refused'
  | 'unreachable'
  | 'reset';

const REACHABILITY_FAILURE_KINDS = new Set<string>([
  'timeout',
  'open-timeout',
  'refused',
  'unreachable',
  'reset',
]);

export function isReachabilityFailureKind(kind: string): kind is ReachabilityFailureKind {
  return REACHABILITY_FAILURE_KINDS.has(kind);
}

export type PeerEndpoint = { host: string; port: number };

export type EndpointBackoffState = {
  failures: number;
  lastFailedAt: number;
  nextEligibleAt: number;
};

export type PeerEndpointBackoffOptions = {
  now?: () => number;
  log?: (msg: string, at: Date) => void;
};

export function parsePeerEndpoint(url: string): PeerEndpoint | null {
  try {
    const parsed = new URL(url);
    const host = canonicalPeerHost(parsed.hostname);
    if (!host) return null;
    const rawPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'wss:' ? 443 : 80;
    if (!Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65535) return null;
    return { host, port: rawPort };
  } catch {
    return null;
  }
}

export function formatPeerEndpointAddr(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function canonicalEndpointSet(urls: string[]): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const parsed = parsePeerEndpoint(url);
    if (!parsed) continue;
    const key = addrKey(parsed.host, parsed.port);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  keys.sort();
  return keys.join('\n');
}

function addrKey(host: string, port: number): string {
  return `${host}|${port}`;
}

function shouldLogBackoff(failures: number): boolean {
  if (failures === 1 || failures === 3) return true;
  if (failures < 6) return false;
  let n = 6;
  while (n < failures) {
    const next = n * 2;
    if (next <= n) return false;
    n = next;
  }
  return n === failures;
}

function delayMs(failures: number): number {
  const exp = ENDPOINT_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(ENDPOINT_BACKOFF_CAP_MS, exp);
}

export class PeerEndpointBackoff {
  private readonly now: () => number;
  private readonly log: (msg: string, at: Date) => void;
  private readonly nodes = new Map<string, Map<string, EndpointBackoffState>>();

  constructor(opts: PeerEndpointBackoffOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log =
      opts.log ??
      ((msg, at) => {
        logLine('[mesh][peer]', msg, at);
      });
  }

  eligible(nodeId: string, url: string, now = this.now()): boolean {
    this.prune(now);
    const state = this.lookup(nodeId, url);
    if (!state) return true;
    return now >= state.nextEligibleAt;
  }

  nextEligibleAt(nodeId: string, url: string): number | null {
    return this.lookup(nodeId, url)?.nextEligibleAt ?? null;
  }

  minWaitMs(nodeId: string, urls: string[], now = this.now()): number {
    let min = Number.POSITIVE_INFINITY;
    for (const url of urls) {
      const state = this.lookup(nodeId, url);
      if (!state) continue;
      const wait = state.nextEligibleAt - now;
      if (wait < min) min = wait;
    }
    return Number.isFinite(min) ? Math.max(0, min) : 0;
  }

  noteFailure(
    nodeId: string,
    url: string,
    kind: string,
    now = this.now()
  ): EndpointBackoffState | null {
    if (!isReachabilityFailureKind(kind)) return null;
    const parsed = parsePeerEndpoint(url);
    if (!parsed) return null;
    this.prune(now);
    const id = nodeId.toLowerCase();
    let addrs = this.nodes.get(id);
    if (!addrs) {
      addrs = new Map();
      this.nodes.set(id, addrs);
    }
    const key = addrKey(parsed.host, parsed.port);
    const prev = addrs.get(key);
    const failures = (prev?.failures ?? 0) + 1;
    const nextEligibleAt = now + delayMs(failures);
    const state: EndpointBackoffState = { failures, lastFailedAt: now, nextEligibleAt };
    addrs.set(key, state);
    if (shouldLogBackoff(failures)) {
      const addr = formatPeerEndpointAddr(parsed.host, parsed.port);
      this.log(
        `endpoint backoff node=${id} addr=${addr} fails=${failures} next=${isoNow(new Date(nextEligibleAt))}`,
        new Date(now)
      );
    }
    return state;
  }

  noteSuccess(nodeId: string, url: string, now = this.now()): void {
    const parsed = parsePeerEndpoint(url);
    if (!parsed) return;
    const id = nodeId.toLowerCase();
    const addrs = this.nodes.get(id);
    if (!addrs) return;
    const key = addrKey(parsed.host, parsed.port);
    const prev = addrs.get(key);
    if (!prev) return;
    addrs.delete(key);
    if (addrs.size === 0) this.nodes.delete(id);
    const addr = formatPeerEndpointAddr(parsed.host, parsed.port);
    this.log(`endpoint recovered node=${id} addr=${addr}`, new Date(now));
  }

  resetNode(nodeId: string): void {
    this.nodes.delete(nodeId.toLowerCase());
  }

  resetAll(): void {
    this.nodes.clear();
  }

  prune(now = this.now()): void {
    const cutoff = now - ENDPOINT_BACKOFF_IDLE_MS;
    for (const [nodeId, addrs] of this.nodes) {
      for (const [key, state] of addrs) {
        if (state.lastFailedAt <= cutoff) addrs.delete(key);
      }
      if (addrs.size === 0) this.nodes.delete(nodeId);
    }
  }

  size(): number {
    let n = 0;
    for (const addrs of this.nodes.values()) n += addrs.size;
    return n;
  }

  private lookup(nodeId: string, url: string): EndpointBackoffState | undefined {
    const parsed = parsePeerEndpoint(url);
    if (!parsed) return undefined;
    return this.nodes.get(nodeId.toLowerCase())?.get(addrKey(parsed.host, parsed.port));
  }
}
