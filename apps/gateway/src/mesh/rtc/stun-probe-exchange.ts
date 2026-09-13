import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { isUnusableEdgeIp } from '../../tunnel/edge-resolver';
import { stunDnsBudgetMs, stunProbePhaseBudget, stunProbeTimeoutMs } from './stun-probe-budget';
import {
  BINDING_ERROR,
  BINDING_SUCCESS,
  TXID_SIZE,
  encodeBindingRequest,
  iceSchemeOf,
  or,
  parseStunMappedAddress,
  parseStunTarget,
  stunMessageType,
} from './stun-probe-codec';
import type { StunProbeDeps, StunProbeResult, StunRinfo, StunUdpSocket } from './stun-probe-types';
import {
  type StunLookup,
  type StunResolveVia,
  resolveIceServers,
  splitIceServerUrl,
  stripHostBrackets,
  stunResolveSnapshot,
} from './stun-resolver';

export const STUN_PROBE_TIMEOUT_MS = 2_000;
export const STUN_PROBE_CONCURRENCY = 4;
export const STUN_PROBE_RTO_MS = 500;

export type {
  StunProbeDeps,
  StunProbeRecord,
  StunProbeResult,
  StunRinfo,
  StunUdpSocket,
} from './stun-probe-types';

type ProbeAddr = { address: string; family: number };
type ResolveOk = { ok: true; targets: ProbeAddr[]; via: StunResolveVia; fakeIp: boolean };
type ResolveFail = { ok: false; error: string; via?: StunResolveVia; fakeIp?: boolean };
type BindingJob = {
  url: string;
  port: number;
  addr: ProbeAddr;
  extra: Partial<StunProbeResult>;
  deps: StunProbeDeps;
  started: number;
  bindTimeoutMs: number;
};
type BindingIo = {
  job: BindingJob;
  txid: Uint8Array;
  now: () => number;
  finish: (result: StunProbeResult) => void;
  timers: ReturnType<typeof setTimeout>[];
  isSettled: () => boolean;
};
type BindResolvedJob = {
  url: string;
  port: number;
  resolved: ResolveOk;
  deps: StunProbeDeps;
  started: number;
  timeoutMs: number;
};

export async function probeStunServer(
  url: string,
  deps: StunProbeDeps = {}
): Promise<StunProbeResult> {
  const now = or(deps.now, Date.now);
  const started = now();
  const timeoutMs = stunProbeTimeoutMs(deps.timeoutMs);
  const scheme = iceSchemeOf(url);
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
  return bindResolved({ url, port: target.port, resolved, deps, started, timeoutMs });
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

async function bindResolved(job: BindResolvedJob): Promise<StunProbeResult> {
  const now = or(job.deps.now, Date.now);
  let last: StunProbeResult | null = null;
  for (const addr of job.resolved.targets) {
    if (job.deps.signal?.aborted) {
      return failResult(
        job.url,
        now() - job.started,
        'aborted',
        metaOf(job.resolved, addr.address)
      );
    }
    const elapsed = now() - job.started;
    const phase = stunProbePhaseBudget(elapsed, job.timeoutMs);
    if (phase.skipBind) {
      return or(last, failResult(job.url, elapsed, 'dns-slow', metaOf(job.resolved, addr.address)));
    }
    last = await exchangeBinding({
      url: job.url,
      port: job.port,
      addr,
      extra: metaOf(job.resolved, addr.address),
      deps: job.deps,
      started: job.started,
      bindTimeoutMs: phase.bindBudgetMs,
    });
    if (last.ok || last.error !== 'ENETUNREACH') return last;
  }
  return or(last, failResult(job.url, now() - job.started, 'dns', metaOf(job.resolved)));
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
  const captured = { ips: [] as string[], err: undefined as unknown };
  const servers = await resolveIceServers([url], {
    lookup: capturingLookup(lookup, captured),
    doh: deps.doh,
    now: deps.now,
    signal: deps.signal,
    budgetMs: Math.max(1, stunDnsBudgetMs(timeoutMs) - (now() - started)),
  });
  return finishStunResolve({ hostname, servers, lookup, captured });
}

function capturingLookup(
  lookup: StunLookup,
  captured: { ips: string[]; err: unknown }
): StunLookup {
  return async (host) => {
    try {
      captured.ips = await lookup(host);
      return captured.ips;
    } catch (err) {
      captured.err = err;
      throw err;
    }
  };
}

async function finishStunResolve(ctx: {
  hostname: string;
  servers: Awaited<ReturnType<typeof resolveIceServers>>;
  lookup: StunLookup;
  captured: { ips: string[]; err: unknown };
}): Promise<ResolveOk | ResolveFail> {
  const key = stripHostBrackets(ctx.hostname).trim().toLowerCase();
  const record = [...stunResolveSnapshot()].reverse().find((row) => row.host === key);
  const parsed = typeof ctx.servers[0] === 'string' ? splitIceServerUrl(ctx.servers[0]) : null;
  const rewritten = parsed ? stripHostBrackets(parsed.host) : ctx.hostname;
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
  let targets = orderedTargets(ctx.captured.ips);
  if (targets.length === 0) {
    try {
      targets = orderedTargets(await ctx.lookup(ctx.hostname));
    } catch (err) {
      return { ok: false, error: errorCode(err, 'dns'), via, fakeIp };
    }
  }
  if (targets.length > 0) return { ok: true, targets, via, fakeIp };
  const fallbackFamily = record?.ip ? isIP(record.ip) : 0;
  if (record?.ip && fallbackFamily) {
    return { ok: true, targets: [{ address: record.ip, family: fallbackFamily }], via, fakeIp };
  }
  return { ok: false, error: errorCode(ctx.captured.err, 'dns'), via, fakeIp };
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

function exchangeBinding(job: BindingJob): Promise<StunProbeResult> {
  const raw = job.deps.randomTxid?.() ?? randomBytes(TXID_SIZE);
  const txid = raw.length >= TXID_SIZE ? raw.subarray(0, TXID_SIZE) : randomBytes(TXID_SIZE);
  return new Promise((resolve) =>
    runBindingExchange(job, txid, encodeBindingRequest(txid), resolve)
  );
}

function runBindingExchange(
  job: BindingJob,
  txid: Uint8Array,
  request: Uint8Array,
  resolve: (result: StunProbeResult) => void
): void {
  const now = job.deps.now ?? Date.now;
  let settled = false;
  if (job.deps.signal?.aborted) {
    resolve(failResult(job.url, now() - job.started, 'aborted', job.extra));
    return;
  }
  let socket: StunUdpSocket;
  try {
    socket = (job.deps.createSocket ?? defaultCreateSocket)(job.addr.family);
  } catch (err) {
    resolve(failResult(job.url, now() - job.started, errorCode(err, 'send'), job.extra));
    return;
  }
  const timers: ReturnType<typeof setTimeout>[] = [];
  const abortFn = () => finish(failResult(job.url, now() - job.started, 'aborted', job.extra));
  const finish = (result: StunProbeResult) => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    job.deps.signal?.removeEventListener('abort', abortFn);
    try {
      socket.close();
    } catch {}
    resolve(result);
  };
  job.deps.signal?.addEventListener('abort', abortFn, { once: true });
  if (settled) return;
  timers.push(
    setTimeout(
      () => finish(failResult(job.url, now() - job.started, 'timeout', job.extra)),
      Math.max(0, job.bindTimeoutMs)
    )
  );
  socket.on('error', (err) =>
    finish(failResult(job.url, now() - job.started, errorCode(err, 'send'), job.extra))
  );
  const io: BindingIo = {
    job,
    txid,
    now,
    finish,
    timers,
    isSettled: () => settled,
  };
  socket.on('message', (msg, rinfo) => onBindingMessage(io, msg, rinfo));
  socket.unref?.();
  armBindingSends(io, socket, request);
}

function onBindingMessage(io: BindingIo, msg: Uint8Array, rinfo: StunRinfo): void {
  if (rinfo.address !== io.job.addr.address || rinfo.port !== io.job.port) return;
  const type = stunMessageType(msg, io.txid);
  if (type === BINDING_ERROR) {
    io.finish(
      okBind(io.job.url, io.now() - io.job.started, { ...io.job.extra, errorResponse: true })
    );
    return;
  }
  const mapped = type === BINDING_SUCCESS ? parseStunMappedAddress(msg, io.txid) : null;
  if (!mapped) return;
  io.finish(
    okBind(io.job.url, io.now() - io.job.started, { ...io.job.extra, mappedAddress: mapped })
  );
}

function armBindingSends(io: BindingIo, socket: StunUdpSocket, request: Uint8Array): void {
  const sendOnce = () => {
    if (io.isSettled()) return;
    try {
      socket.send(request, io.job.port, io.job.addr.address, (error) => {
        if (error) {
          io.finish(
            failResult(
              io.job.url,
              io.now() - io.job.started,
              errorCode(error, 'send'),
              io.job.extra
            )
          );
        }
      });
    } catch (err) {
      io.finish(
        failResult(io.job.url, io.now() - io.job.started, errorCode(err, 'send'), io.job.extra)
      );
    }
  };
  let at = 0;
  const rto = io.job.deps.rtoMs ?? STUN_PROBE_RTO_MS;
  for (const gap of [rto, rto * 2]) {
    at += gap;
    if (at >= io.job.bindTimeoutMs) break;
    io.timers.push(setTimeout(sendOnce, at));
  }
  sendOnce();
}

function defaultLookup(hostname: string): Promise<string[]> {
  return dnsPromises.lookup(hostname, { all: true }).then((rows) => rows.map((r) => r.address));
}

function defaultCreateSocket(family: number): StunUdpSocket {
  const s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  s.unref();
  return s as unknown as StunUdpSocket;
}

function errorCode(err: unknown, fallback: string): string {
  const code =
    typeof err === 'object' && err && 'code' in err ? (err as { code?: unknown }).code : null;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}
