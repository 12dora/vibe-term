import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { logAt } from '../../log/level';
import { stamp } from '../mesh-log';
import { parseTurnUri } from './ice';
import { formatRtcLog, rtcLog } from './rtc-log';

export const STUN_PROBE_TIMEOUT_MS = 2_000;
export const STUN_PROBE_INTERVAL_MS = 10 * 60 * 1_000;
export const STUN_MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const FAMILY_IPV4 = 0x01;
const FAMILY_IPV6 = 0x02;
const HEADER_SIZE = 20;
const TXID_SIZE = 12;

export type StunProbeResult = {
  url: string;
  ok: boolean;
  rttMs: number;
  mappedAddress?: string;
  error?: string;
  resolvedIp?: string;
};

export type StunProbeRecord = StunProbeResult & { probedAt: number };

export type StunUdpSocket = {
  send(
    msg: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void;
  on(event: 'message', listener: (msg: Uint8Array) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  close(): void;
  unref?(): void;
};

export type StunProbeLookup = (hostname: string) => Promise<{ address: string; family: number }>;
export type StunSocketFactory = (family: number) => StunUdpSocket;

export type StunProbeDeps = {
  lookup?: StunProbeLookup;
  createSocket?: StunSocketFactory;
  now?: () => number;
  timeoutMs?: number;
  randomTxid?: () => Uint8Array;
};

export type StunProbeRtc = {
  currentIceConfig(): { stun: string[] };
};

export type StunProbeScheduler = {
  interval(fn: () => void, ms: number): { clear: () => void };
};

export type StunProbeLoopDeps = {
  probeAll?: (urls: readonly string[]) => Promise<StunProbeResult[]>;
  now?: () => number;
};

type StunTarget = { hostname: string; port: number };

const MAGIC_BYTES = Uint8Array.of(0x21, 0x12, 0xa4, 0x42);

let lastResults: StunProbeRecord[] = [];
let lastKey: string | null = null;
let inflight: Promise<void> | null = null;
let queued: string[] | null = null;
let intervalHandle: { clear: () => void } | null = null;
let loopDeps: StunProbeLoopDeps = {};

export function stunProbeSnapshot(): readonly StunProbeRecord[] {
  return lastResults;
}

export function resetStunProbeForTest(): void {
  lastResults = [];
  lastKey = null;
  inflight = null;
  queued = null;
  intervalHandle?.clear();
  intervalHandle = null;
  loopDeps = {};
}

export function setStunProbeLoopForTest(deps: StunProbeLoopDeps): void {
  loopDeps = deps;
}

export function parseStunTarget(url: string): StunTarget | null {
  const trimmed = url.trim();
  if (!/^stun:/i.test(trimmed) || /^stuns:/i.test(trimmed)) return null;
  const parsed = parseTurnUri(trimmed);
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
  if (!isBindingSuccess(msg, txid)) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const length = view.getUint16(2);
  const end = Math.min(msg.length, HEADER_SIZE + length);
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
  const now = deps.now ?? Date.now;
  const started = now();
  const timeoutMs = deps.timeoutMs ?? STUN_PROBE_TIMEOUT_MS;
  const target = parseStunTarget(url);
  if (!target) return failResult(url, now() - started, 'url');
  const resolved = await resolveStunHost(target.hostname, deps, timeoutMs);
  if (!resolved.ok) return failResult(url, now() - started, resolved.error);
  return await exchangeBinding(url, target.port, resolved, deps, started, timeoutMs);
}

export function probeStunServers(
  urls: readonly string[],
  deps: StunProbeDeps = {}
): Promise<StunProbeResult[]> {
  return Promise.all(urls.map((url) => probeStunServer(url, deps)));
}

export function withStunProbes<T extends { stun: string[]; turn: unknown } | null>(
  cfg: T
): { stun: string[]; turn: unknown; probes: StunProbeRecord[] } {
  const base = cfg ?? { stun: [], turn: null };
  return { stun: base.stun, turn: base.turn, probes: lastResults.slice() };
}

export function startMeshStunProbe(rtc: StunProbeRtc, scheduler: StunProbeScheduler): void {
  stopMeshStunProbe();
  const getUrls = () => rtc.currentIceConfig().stun;
  void runProbeCycle(getUrls());
  intervalHandle = scheduler.interval(() => {
    void runProbeCycle(getUrls());
  }, STUN_PROBE_INTERVAL_MS);
}

export function stopMeshStunProbe(after?: () => void): void {
  intervalHandle?.clear();
  intervalHandle = null;
  after?.();
}

export function syncStunProbe(rtc: StunProbeRtc): void {
  const urls = rtc.currentIceConfig().stun;
  if (stunListKey(urls) === lastKey) return;
  void runProbeCycle(urls);
}

function stunListKey(urls: readonly string[]): string {
  return urls.join('\0');
}

function runProbeCycle(urls: string[]): Promise<void> {
  if (inflight) {
    queued = urls;
    return inflight;
  }
  inflight = (async () => {
    let current = urls;
    for (;;) {
      lastKey = stunListKey(current);
      let results: StunProbeResult[];
      try {
        results = await (loopDeps.probeAll ?? probeStunServers)(current);
      } catch {
        results = current.map((url) => failResult(url, 0, 'error'));
      }
      const probedAt = (loopDeps.now ?? Date.now)();
      lastResults = results.map((row) => ({ ...row, probedAt }));
      logProbeBatch(lastResults);
      if (!queued) break;
      current = queued;
      queued = null;
      if (stunListKey(current) === lastKey) break;
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function logProbeBatch(results: readonly StunProbeRecord[]): void {
  for (const row of results) logProbeRow(row);
  if (results.length > 0 && results.every((row) => !row.ok)) {
    logAt('warn', stamp(formatRtcLog('stun unreachable', { all: results.length })));
  }
}

function logProbeRow(row: StunProbeRecord): void {
  if (row.ok) {
    rtcLog('stun probe', {
      url: row.url,
      ok: true,
      rtt_ms: row.rttMs,
      mapped: row.mappedAddress,
    });
    return;
  }
  rtcLog('stun probe', { url: row.url, ok: false, error: row.error ?? 'error' });
}

function failResult(
  url: string,
  rttMs: number,
  error: string,
  resolvedIp?: string
): StunProbeResult {
  return {
    url,
    ok: false,
    rttMs: Math.max(0, rttMs),
    error,
    ...(resolvedIp ? { resolvedIp } : {}),
  };
}

async function resolveStunHost(
  hostname: string,
  deps: StunProbeDeps,
  timeoutMs: number
): Promise<{ ok: true; address: string; family: number } | { ok: false; error: string }> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return { ok: true, address: hostname, family };
  const lookup = deps.lookup ?? defaultLookup;
  try {
    const resolved = await raceTimeout(lookup(hostname), timeoutMs);
    if (!resolved.address) return { ok: false, error: 'dns' };
    return { ok: true, address: resolved.address, family: resolved.family };
  } catch {
    return { ok: false, error: 'dns' };
  }
}

function exchangeBinding(
  url: string,
  port: number,
  resolved: { address: string; family: number },
  deps: StunProbeDeps,
  started: number,
  timeoutMs: number
): Promise<StunProbeResult> {
  const now = deps.now ?? Date.now;
  const txid = takeTxid(deps);
  const request = encodeBindingRequest(txid);
  return new Promise((resolve) => {
    let settled = false;
    let socket: StunUdpSocket;
    try {
      socket = (deps.createSocket ?? defaultCreateSocket)(resolved.family);
    } catch {
      resolve(failResult(url, now() - started, 'send', resolved.address));
      return;
    }
    const timer = setTimeout(
      () => {
        finish(failResult(url, now() - started, 'timeout', resolved.address));
      },
      Math.max(0, timeoutMs - (now() - started))
    );
    const finish = (result: StunProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(result);
    };
    socket.on('error', () => finish(failResult(url, now() - started, 'send', resolved.address)));
    socket.on('message', (msg) => {
      const mapped = parseStunMappedAddress(msg, txid);
      if (!mapped) return;
      finish({
        url,
        ok: true,
        rttMs: Math.max(0, now() - started),
        mappedAddress: mapped,
        resolvedIp: resolved.address,
      });
    });
    socket.unref?.();
    try {
      socket.send(request, port, resolved.address, (error) => {
        if (error) finish(failResult(url, now() - started, 'send', resolved.address));
      });
    } catch {
      finish(failResult(url, now() - started, 'send', resolved.address));
    }
  });
}

function takeTxid(deps: StunProbeDeps): Uint8Array {
  const txid = deps.randomTxid?.() ?? randomBytes(TXID_SIZE);
  return txid.length >= TXID_SIZE ? txid.subarray(0, TXID_SIZE) : randomBytes(TXID_SIZE);
}

function defaultLookup(hostname: string): Promise<{ address: string; family: number }> {
  return dnsPromises.lookup(hostname);
}

function defaultCreateSocket(family: number): StunUdpSocket {
  const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  socket.unref();
  return socket as unknown as StunUdpSocket;
}

function isBindingSuccess(msg: Uint8Array, txid: Uint8Array): boolean {
  if (msg.length < HEADER_SIZE) return false;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  if (view.getUint16(0) !== BINDING_SUCCESS) return false;
  if (view.getUint32(4) !== STUN_MAGIC_COOKIE) return false;
  for (let i = 0; i < TXID_SIZE; i++) {
    if (msg[8 + i] !== txid[i]) return false;
  }
  return true;
}

function decodeMapped(value: Uint8Array, txid: Uint8Array, xor: boolean): string | null {
  if (value.length < 4) return null;
  const family = value[1];
  const rawPort = ((value[2] ?? 0) << 8) | (value[3] ?? 0);
  const port = xor ? rawPort ^ (STUN_MAGIC_COOKIE >>> 16) : rawPort;
  if (family === FAMILY_IPV4) return decodeIpv4(value, xor, port);
  if (family === FAMILY_IPV6) return decodeIpv6(value, txid, xor, port);
  return null;
}

function decodeIpv4(value: Uint8Array, xor: boolean, port: number): string | null {
  if (value.length < 8) return null;
  const parts = [0, 1, 2, 3].map((i) => {
    const raw = value[4 + i] ?? 0;
    return xor ? raw ^ (MAGIC_BYTES[i] ?? 0) : raw;
  });
  return `${parts.join('.')}:${port}`;
}

function decodeIpv6(
  value: Uint8Array,
  txid: Uint8Array,
  xor: boolean,
  port: number
): string | null {
  if (value.length < 20) return null;
  const mask = xor ? Uint8Array.of(...MAGIC_BYTES, ...txid.subarray(0, TXID_SIZE)) : null;
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = value[4 + i * 2] ?? 0;
    const lo = value[5 + i * 2] ?? 0;
    const raw = (hi << 8) | lo;
    const xored = mask ? raw ^ ((mask[i * 2] ?? 0) << 8) ^ (mask[i * 2 + 1] ?? 0) : raw;
    groups.push(xored.toString(16));
  }
  return `[${compressIpv6(groups)}]:${port}`;
}

function compressIpv6(groups: string[]): string {
  return groups.map((g) => g.replace(/^0+(?=\w)/, '') || '0').join(':');
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
