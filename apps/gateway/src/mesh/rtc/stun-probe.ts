import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { logAt } from '../../log/level';
import { isUnusableEdgeIp } from '../../tunnel/edge-resolver';
import { stamp } from '../mesh-log';
import { maskIceAddress, parseTurnUri } from './ice';
import { formatRtcLog, rtcLog } from './rtc-log';
import { stunDnsBudgetMs, stunProbePhaseBudget, stunProbeTimeoutMs } from './stun-probe-budget';
import {
  type StunDoh,
  type StunLookup,
  type StunResolveVia,
  resolveIceServers,
  splitIceServerUrl,
  stripHostBrackets,
  stunResolveSnapshot,
} from './stun-resolver';
export { STUN_PROBE_MIN_BIND_MS } from './stun-probe-budget';
export { rankStunByProbes } from './stun-rank';
export const STUN_PROBE_TIMEOUT_MS = 2_000;
export const STUN_PROBE_INTERVAL_MS = 10 * 60 * 1_000;
export const STUN_PROBE_MIN_INTERVAL_MS = 30_000;
export const STUN_PROBE_CONCURRENCY = 4;
export const STUN_PROBE_RTO_MS = 500;
export const STUN_MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const BINDING_ERROR = 0x0111;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const FAMILY_IPV4 = 0x01;
const FAMILY_IPV6 = 0x02;
const HEADER_SIZE = 20;
const TXID_SIZE = 12;
const ICE_SCHEME_RE = /^(stuns?|turns?):/i;
const MAGIC_BYTES = Uint8Array.of(0x21, 0x12, 0xa4, 0x42);
export type StunProbeResult = {
  url: string;
  ok: boolean;
  rttMs: number;
  mappedAddress?: string;
  error?: string;
  resolvedIp?: string;
  via?: StunResolveVia;
  fakeIp?: boolean;
  errorResponse?: boolean;
  skipped?: 'unsupported-scheme';
};

export type StunProbeRecord = StunProbeResult & { probedAt: number };

export type StunRinfo = { address: string; port: number };

export type StunUdpSocket = {
  send(
    msg: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void;
  on(event: 'message', listener: (msg: Uint8Array, rinfo: StunRinfo) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  close(): void;
  unref?(): void;
};

export type StunProbeDeps = {
  lookup?: StunLookup;
  doh?: StunDoh;
  createSocket?: (family: number) => StunUdpSocket;
  now?: () => number;
  timeoutMs?: number;
  randomTxid?: () => Uint8Array;
  rtoMs?: number;
  signal?: AbortSignal;
};

export type StunProbeRtc = { currentIceConfig(): { stun: string[] } };
export type StunProbeScheduler = { interval(fn: () => void, ms: number): { clear: () => void } };
export type StunProbeLoopDeps = {
  probeAll?: (urls: readonly string[]) => Promise<StunProbeResult[]>;
  now?: () => number;
  random?: () => number;
  minIntervalMs?: number;
};

export type StunProbeHandle = { stop(after?: () => void): void };
type StunTarget = { hostname: string; port: number };
type ProbeAddr = { address: string; family: number };
type ResolveOk = { ok: true; targets: ProbeAddr[]; via: StunResolveVia; fakeIp: boolean };
type ResolveFail = { ok: false; error: string; via?: StunResolveVia; fakeIp?: boolean };
let session: MeshStunProbe | null = null;
let loopDeps: StunProbeLoopDeps = {};

export function stunProbeSnapshot(): readonly StunProbeRecord[] {
  return session?.lastResults ?? [];
}
export function resetStunProbeForTest(): void {
  session?.stop();
  session = null;
  loopDeps = {};
}

export function setStunProbeLoopForTest(deps: StunProbeLoopDeps): void {
  loopDeps = deps;
}

export function parseStunTarget(url: string): StunTarget | null {
  if (ICE_SCHEME_RE.exec(url.trim())?.[0]?.toLowerCase() !== 'stun:') return null;
  const parsed = parseTurnUri(url);
  if (!parsed?.hostname || !Number.isFinite(parsed.port) || parsed.port <= 0) return null;
  return { hostname: parsed.hostname, port: parsed.port };
}

export function encodeBindingRequest(txid: Uint8Array): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint16(0, BINDING_REQUEST);
  view.setUint16(2, 0);
  view.setUint32(4, STUN_MAGIC_COOKIE);
  buf.set(txid.subarray(0, TXID_SIZE), 8);
  return buf;
}

export function parseStunMappedAddress(msg: Uint8Array, txid: Uint8Array): string | null {
  if (stunMessageType(msg, txid) !== BINDING_SUCCESS) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const end = Math.min(msg.length, HEADER_SIZE + view.getUint16(2));
  let xorMapped: string | null = null;
  let mapped: string | null = null;
  let offset = HEADER_SIZE;
  while (offset + 4 <= end) {
    const type = view.getUint16(offset);
    const attrLen = view.getUint16(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + attrLen;
    if (valueEnd > end) break;
    const value = msg.subarray(valueStart, valueEnd);
    if (type === ATTR_XOR_MAPPED_ADDRESS) xorMapped = decodeMapped(value, txid, true);
    else if (type === ATTR_MAPPED_ADDRESS) mapped = decodeMapped(value, txid, false);
    offset = valueStart + ((attrLen + 3) & ~3);
  }
  return xorMapped ?? mapped;
}

export async function probeStunServer(
  url: string,
  deps: StunProbeDeps = {}
): Promise<StunProbeResult> {
  const now = or(deps.now, Date.now);
  const started = now();
  const timeoutMs = stunProbeTimeoutMs(deps.timeoutMs);
  const scheme = ICE_SCHEME_RE.exec(url.trim())?.[0]?.toLowerCase();
  if (scheme && scheme !== 'stun:') {
    return { url, ok: false, rttMs: 0, skipped: 'unsupported-scheme' };
  }
  const target = parseStunTarget(url);
  if (!target) return failResult(url, now() - started, 'url');
  const resolved = await resolveStunHost(url, target.hostname, deps, started, timeoutMs);
  if (!resolved.ok) {
    return failResult(url, now() - started, resolved.error, {
      via: resolved.via,
      fakeIp: resolved.fakeIp,
    });
  }
  let last: StunProbeResult | null = null;
  for (const addr of resolved.targets) {
    if (deps.signal?.aborted) {
      return failResult(url, now() - started, 'aborted', metaOf(resolved, addr.address));
    }
    const elapsed = now() - started;
    const phase = stunProbePhaseBudget(elapsed, timeoutMs);
    if (phase.skipBind) {
      return or(last, failResult(url, elapsed, 'dns-slow', metaOf(resolved, addr.address)));
    }
    last = await exchangeBinding(
      url,
      target.port,
      addr,
      resolved,
      deps,
      started,
      phase.bindBudgetMs
    );
    if (last.ok || last.error !== 'ENETUNREACH') return last;
  }
  return or(last, failResult(url, now() - started, 'dns', metaOf(resolved)));
}

export async function probeStunServers(
  urls: readonly string[],
  deps: StunProbeDeps = {}
): Promise<StunProbeResult[]> {
  const out: StunProbeResult[] = [];
  for (let i = 0; i < urls.length; i += STUN_PROBE_CONCURRENCY) {
    const chunk = urls.slice(i, i + STUN_PROBE_CONCURRENCY);
    out.push(...(await Promise.all(chunk.map((url) => probeStunServer(url, deps)))));
  }
  return out;
}

export function withStunProbes<T extends { stun: string[]; turn: unknown } | null>(
  cfg: T
): { stun: string[]; turn: unknown; probes: StunProbeRecord[] } {
  const base = cfg ?? { stun: [], turn: null };
  return { stun: base.stun, turn: base.turn, probes: stunProbeSnapshot().slice() };
}

export function startMeshStunProbe(
  rtc: StunProbeRtc,
  scheduler: StunProbeScheduler
): StunProbeHandle {
  session?.stop();
  session = new MeshStunProbe(rtc, scheduler, loopDeps);
  session.start();
  return { stop: (after) => stopMeshStunProbe(after) };
}

export function stopMeshStunProbe(after?: () => void): void {
  session?.stop();
  after?.();
}

export function syncStunProbe(rtc: StunProbeRtc): void {
  session?.sync(rtc);
}

class MeshStunProbe {
  lastResults: StunProbeRecord[] = [];
  private lastKey: string | null = null;
  private lastCycleAt = 0;
  private inflight: Promise<void> | null = null;
  private queued: string[] | null = null;
  private pending: string[] | null = null;
  private tick: { clear: () => void } | null = null;
  private waitH: { clear: () => void } | null = null;
  private readonly ac = new AbortController();
  private stopped = false;
  private armed = false;

  constructor(
    private readonly rtc: StunProbeRtc,
    private readonly scheduler: StunProbeScheduler,
    private readonly opts: StunProbeLoopDeps
  ) {}

  start(): void {
    void this.runCycle(this.rtc.currentIceConfig().stun);
    this.armTick();
  }

  stop(): void {
    this.stopped = true;
    this.ac.abort();
    this.tick?.clear();
    this.waitH?.clear();
    this.tick = this.waitH = null;
    this.queued = this.pending = null;
  }

  sync(rtc: StunProbeRtc): void {
    const urls = rtc.currentIceConfig().stun;
    if ([...urls].sort().join('\0') === this.lastKey) return;
    const min = this.opts.minIntervalMs ?? STUN_PROBE_MIN_INTERVAL_MS;
    const elapsed = (this.opts.now ?? Date.now)() - this.lastCycleAt;
    if (this.lastCycleAt > 0 && elapsed < min) {
      this.armWait(urls, min - elapsed);
      return;
    }
    void this.runCycle(urls);
  }

  private armTick(): void {
    if (this.stopped || this.armed) return;
    this.armed = true;
    const rand = this.opts.random ?? Math.random;
    const ms = Math.round(STUN_PROBE_INTERVAL_MS * (1 + (rand() * 2 - 1) * 0.1));
    this.tick = this.scheduler.interval(() => {
      if (!this.stopped) void this.runCycle(this.rtc.currentIceConfig().stun);
    }, ms);
  }

  private armWait(urls: string[], ms: number): void {
    if (this.stopped) return;
    this.pending = urls;
    this.waitH?.clear();
    this.waitH = this.scheduler.interval(() => {
      this.waitH?.clear();
      this.waitH = null;
      const next = this.pending ?? this.rtc.currentIceConfig().stun;
      this.pending = null;
      if (!this.stopped && [...next].sort().join('\0') !== this.lastKey) void this.runCycle(next);
    }, ms);
  }

  private runCycle(urls: string[]): Promise<void> {
    if (this.inflight) {
      this.queued = urls;
      return this.inflight;
    }
    this.inflight = this.loop(urls)
      .catch(() => {})
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async loop(urls: string[]): Promise<void> {
    let current = urls;
    const clock = this.opts.now ?? Date.now;
    const probeAll =
      this.opts.probeAll ??
      ((list: readonly string[]) =>
        probeStunServers([...list], { signal: this.ac.signal, now: this.opts.now }));
    for (;;) {
      if (this.stopped || this.ac.signal.aborted) return;
      this.lastKey = [...current].sort().join('\0');
      this.lastCycleAt = clock();
      if (process.env.NODE_ENV === 'test' && !this.opts.probeAll) return;
      let results: StunProbeResult[];
      try {
        results = await probeAll(current);
      } catch {
        results = current.map((url) => failResult(url, 0, 'error'));
      }
      if (this.stopped) return;
      this.lastResults = results.map((row) => ({ ...row, probedAt: clock() }));
      try {
        logProbeBatch(this.lastResults);
      } catch {}
      if (!this.queued) break;
      current = this.queued;
      this.queued = null;
      if ([...current].sort().join('\0') === this.lastKey) break;
      const min = this.opts.minIntervalMs ?? STUN_PROBE_MIN_INTERVAL_MS;
      const wait = min - (clock() - this.lastCycleAt);
      if (wait > 0) {
        this.armWait(current, wait);
        break;
      }
    }
  }
}

function logProbeBatch(results: readonly StunProbeRecord[]): void {
  for (const row of results) {
    rtcLog('stun probe', {
      url: row.url,
      skipped: row.skipped,
      ok: row.skipped ? undefined : row.ok,
      rtt_ms: row.ok ? row.rttMs : undefined,
      mapped: row.mappedAddress ? maskIceAddress(row.mappedAddress) : undefined,
      error_response: row.errorResponse || undefined,
      error: row.ok || row.skipped ? undefined : (row.error ?? 'error'),
      via: row.skipped ? undefined : row.via,
      fake_ip: row.skipped ? undefined : row.fakeIp,
    });
  }
  const attempted = results.filter((row) => !row.skipped);
  if (attempted.length > 0 && attempted.every((row) => !row.ok)) {
    logAt('warn', stamp(formatRtcLog('stun unreachable', { all: attempted.length })));
  }
}

function failResult(
  url: string,
  rttMs: number,
  error: string,
  extra: Partial<StunProbeResult> = {}
): StunProbeResult {
  return { url, ok: false, rttMs: Math.max(0, rttMs), error, ...extra };
}

function okBind(url: string, rttMs: number, extra: Partial<StunProbeResult>): StunProbeResult {
  return { url, ok: true, rttMs: Math.max(0, rttMs), ...extra };
}

function metaOf(resolved: ResolveOk, address?: string): Partial<StunProbeResult> {
  return {
    via: resolved.via,
    fakeIp: resolved.fakeIp,
    ...(address ? { resolvedIp: address } : {}),
  };
}

async function resolveStunHost(
  url: string,
  hostname: string,
  deps: StunProbeDeps,
  started: number,
  timeoutMs: number
): Promise<ResolveOk | ResolveFail> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    return { ok: true, targets: [{ address: hostname, family }], via: 'system', fakeIp: false };
  }
  const now = or(deps.now, Date.now);
  const lookup = or(deps.lookup, defaultLookup);
  let captured: string[] = [];
  let lookupErr: unknown;
  const capturing: StunLookup = async (host) => {
    try {
      captured = await lookup(host);
      return captured;
    } catch (err) {
      lookupErr = err;
      throw err;
    }
  };
  const dnsBudget = Math.max(1, stunDnsBudgetMs(timeoutMs) - (now() - started));
  const servers = await resolveIceServers([url], {
    lookup: capturing,
    doh: deps.doh,
    now: deps.now,
    signal: deps.signal,
    budgetMs: dnsBudget,
  });
  const key = stripHostBrackets(hostname).trim().toLowerCase();
  const record = [...stunResolveSnapshot()].reverse().find((row) => row.host === key);
  const parsed = typeof servers[0] === 'string' ? splitIceServerUrl(servers[0]) : null;
  const rewritten = parsed ? stripHostBrackets(parsed.host) : hostname;
  const rewrittenFamily = isIP(rewritten);
  if (rewrittenFamily) {
    return {
      ok: true,
      targets: [{ address: rewritten, family: rewrittenFamily }],
      via: or(record?.via, 'doh'),
      fakeIp: or(record?.fakeIp, false),
    };
  }
  const via = or(record?.via, 'system');
  const fakeIp = or(record?.fakeIp, false);
  let targets = orderedTargets(captured);
  if (targets.length === 0) {
    try {
      targets = orderedTargets(await lookup(hostname));
    } catch (err) {
      return { ok: false, error: errorCode(err, 'dns'), via, fakeIp };
    }
  }
  if (targets.length > 0) return { ok: true, targets, via, fakeIp };
  const fallbackFamily = record?.ip ? isIP(record.ip) : 0;
  if (record?.ip && fallbackFamily) {
    return { ok: true, targets: [{ address: record.ip, family: fallbackFamily }], via, fakeIp };
  }
  return { ok: false, error: errorCode(lookupErr, 'dns'), via, fakeIp };
}

function orderedTargets(ips: readonly string[]): ProbeAddr[] {
  const usable = ips.filter((ip) => {
    const family = isIP(ip);
    return family === 6 || (family === 4 && !isUnusableEdgeIp(ip));
  });
  return ([4, 6] as const).flatMap((family) =>
    usable.filter((ip) => isIP(ip) === family).map((address) => ({ address, family }))
  );
}

function exchangeBinding(
  url: string,
  port: number,
  addr: ProbeAddr,
  resolved: ResolveOk,
  deps: StunProbeDeps,
  started: number,
  bindTimeoutMs: number
): Promise<StunProbeResult> {
  const now = deps.now ?? Date.now;
  const extra = metaOf(resolved, addr.address);
  const raw = deps.randomTxid?.() ?? randomBytes(TXID_SIZE);
  const txid = raw.length >= TXID_SIZE ? raw.subarray(0, TXID_SIZE) : randomBytes(TXID_SIZE);
  const request = encodeBindingRequest(txid);
  return new Promise((resolve) => {
    let settled = false;
    if (deps.signal?.aborted) {
      resolve(failResult(url, now() - started, 'aborted', extra));
      return;
    }
    let socket: StunUdpSocket;
    try {
      socket = (deps.createSocket ?? defaultCreateSocket)(addr.family);
    } catch (err) {
      resolve(failResult(url, now() - started, errorCode(err, 'send'), extra));
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const abortFn = () => finish(failResult(url, now() - started, 'aborted', extra));
    const finish = (result: StunProbeResult) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      deps.signal?.removeEventListener('abort', abortFn);
      try {
        socket.close();
      } catch {}
      resolve(result);
    };
    deps.signal?.addEventListener('abort', abortFn, { once: true });
    if (settled) return;
    timers.push(
      setTimeout(
        () => finish(failResult(url, now() - started, 'timeout', extra)),
        Math.max(0, bindTimeoutMs)
      )
    );
    socket.on('error', (err) =>
      finish(failResult(url, now() - started, errorCode(err, 'send'), extra))
    );
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== addr.address || rinfo.port !== port) return;
      const type = stunMessageType(msg, txid);
      if (type === BINDING_ERROR) {
        finish(okBind(url, now() - started, { ...extra, errorResponse: true }));
        return;
      }
      const mapped = type === BINDING_SUCCESS ? parseStunMappedAddress(msg, txid) : null;
      if (!mapped) return;
      finish(okBind(url, now() - started, { ...extra, mappedAddress: mapped }));
    });
    socket.unref?.();
    const sendOnce = () => {
      if (settled) return;
      try {
        socket.send(request, port, addr.address, (error) => {
          if (error) finish(failResult(url, now() - started, errorCode(error, 'send'), extra));
        });
      } catch (err) {
        finish(failResult(url, now() - started, errorCode(err, 'send'), extra));
      }
    };
    let at = 0;
    const rto = deps.rtoMs ?? STUN_PROBE_RTO_MS;
    for (const gap of [rto, rto * 2]) {
      at += gap;
      if (at >= bindTimeoutMs) break;
      timers.push(setTimeout(sendOnce, at));
    }
    sendOnce();
  });
}

function defaultLookup(hostname: string): Promise<string[]> {
  return dnsPromises.lookup(hostname, { all: true }).then((rows) => rows.map((r) => r.address));
}
function defaultCreateSocket(family: number): StunUdpSocket {
  const s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  s.unref();
  return s as unknown as StunUdpSocket;
}
function stunMessageType(msg: Uint8Array, txid: Uint8Array): number | null {
  if (msg.length < HEADER_SIZE) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  if (view.getUint32(4) !== STUN_MAGIC_COOKIE) return null;
  for (let i = 0; i < TXID_SIZE; i++) {
    if (msg[8 + i] !== txid[i]) return null;
  }
  return view.getUint16(0);
}
function decodeMapped(value: Uint8Array, txid: Uint8Array, xor: boolean): string | null {
  if (value.length < 4) return null;
  const family = value[1];
  const rawPort = (or(value[2], 0) << 8) | or(value[3], 0);
  const port = xor ? rawPort ^ (STUN_MAGIC_COOKIE >>> 16) : rawPort;
  if (family === FAMILY_IPV4) {
    if (value.length < 8) return null;
    const parts = [0, 1, 2, 3].map((i) => {
      const raw = or(value[4 + i], 0);
      return xor ? raw ^ or(MAGIC_BYTES[i], 0) : raw;
    });
    return `${parts.join('.')}:${port}`;
  }
  if (family !== FAMILY_IPV6 || value.length < 20) return null;
  const mask = xor ? Uint8Array.of(...MAGIC_BYTES, ...txid.subarray(0, TXID_SIZE)) : null;
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = or(value[4 + i * 2], 0);
    const lo = or(value[5 + i * 2], 0);
    const raw = (hi << 8) | lo;
    const xored = mask ? raw ^ (or(mask[i * 2], 0) << 8) ^ or(mask[i * 2 + 1], 0) : raw;
    groups.push(xored.toString(16));
  }
  const text = groups.map((part) => part.replace(/^0+(?=\w)/, '') || '0').join(':');
  let host = text;
  try {
    host = new URL(`http://[${text}]`).hostname.slice(1, -1);
  } catch {}
  return `[${host}]:${port}`;
}
function or<T>(value: T | null | undefined, fallback: T): T {
  return value == null ? fallback : value;
}
function errorCode(err: unknown, fallback: string): string {
  const code =
    typeof err === 'object' && err && 'code' in err ? (err as { code?: unknown }).code : null;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}
