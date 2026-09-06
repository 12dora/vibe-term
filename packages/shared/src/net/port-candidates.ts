// 非标端口探测：80/443 被封锁时，Hub / 中继会架在高位端口上，而用户手里往往只有一个不带端口的地址。
//
// 这里只做两件事：给出内置的高位端口候选表，以及按候选表探一遍找出真正在监听的那个端口。
// 模块必须保持浏览器安全（不引 `node:*`）：前端 bundle 会带上 `@vibeterm/shared/net`。
// 探测本身仍只在 Bun 侧执行——浏览器跨域打不到 `/api/relay/health`。

import { canonicalHubUrl } from '../auth/hub-url';

/**
 * 建议的高位端口。前五个是 Cloudflare 橙云代理 HTTPS 时放行的端口（套 CDN 时不必再换端口），
 * 后三个 IANA 未分配，且低于 Linux 默认临时端口起点 32768，不会与内核分配的出站端口抢占。
 * 低于 1024 的端口需要 root，一律不进候选。
 */
export const SUGGESTED_HIGH_PORTS = [2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443] as const;

/** 单次探测请求的超时。 */
export const PROBE_DEFAULT_TIMEOUT_MS = 4000;
/** 443 的独占宽限期：绝大多数部署在这里就结束了，不必惊动候选表。 */
export const PROBE_DEFAULT_GRACE_MS = 800;
/** 候选之间的错开间隔，避免一次性拉起十条连接。 */
export const PROBE_DEFAULT_STAGGER_MS = 150;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
/** 只取 authority 里显式写出的端口：`new URL()` 会把 `:443` 这类默认端口吞掉。 */
const AUTHORITY_PORT_RE =
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:]*)(?::(\d+))?/;

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

export type ProbeKind = 'relay' | 'hub';

export interface ProbeTarget {
  /** 规范化后的地址（`canonicalHubUrl`），默认端口不出现在里面。 */
  base: string;
  protocol: string;
  /** 用户显式写出的端口；没写为 `null`。 */
  explicitPort: number | null;
  /** 实际会去连的端口（未写端口时即协议默认端口）。 */
  port: number;
}

export interface PortProbeResult {
  /** 探通的规范化地址；一个都没通为 `null`。 */
  url: string | null;
  port: number | null;
  /** 用户显式写了端口：只做一次确认，不遍历候选。 */
  explicit: boolean;
  triedPorts: number[];
}

export type ProbeFetch = (
  input: string,
  init: { signal: AbortSignal; redirect: RequestRedirect }
) => Promise<Response>;

export interface ProbeAddressPortsOptions {
  kind: ProbeKind;
  timeoutMs?: number;
  graceMs?: number;
  staggerMs?: number;
  ports?: readonly number[];
  fetchImpl?: ProbeFetch;
  signal?: AbortSignal;
  /** 改写实际拨号目标（自己拨自己时回环短路），但不改变对外报告的地址。 */
  resolveDialUrl?: (url: string) => string;
}

/** 裸主机名按回环与否补 scheme，随后一律过 `canonicalHubUrl`，与全系统同一把尺子。 */
export function parseProbeTarget(hostOrUrl: string): ProbeTarget {
  const trimmed = hostOrUrl.trim();
  if (!trimmed) throw new Error('invalid probe target: empty address');
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `${bareHostScheme(trimmed)}://${trimmed}`;
  const base = canonicalHubUrl(withScheme);
  const protocol = new URL(base).protocol;
  const explicitPort = readExplicitPort(withScheme);
  return {
    base,
    protocol,
    explicitPort,
    port: explicitPort ?? (protocol === 'https:' ? 443 : 80),
  };
}

function bareHostScheme(bare: string): string {
  try {
    return isLoopbackHostname(new URL(`https://${bare}`).hostname) ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

function readExplicitPort(withScheme: string): number | null {
  const port = AUTHORITY_PORT_RE.exec(withScheme)?.[1];
  return port ? Number(port) : null;
}

function withPort(base: string, port: number): string {
  const url = new URL(base);
  url.port = String(port);
  return canonicalHubUrl(url.toString());
}

/** 显式端口与回环只有一个候选；其余是「默认端口 + 候选表」。 */
export function candidateUrls(hostOrUrl: string, ports?: readonly number[]): string[] {
  const target = parseProbeTarget(hostOrUrl);
  if (isSingleCandidate(target)) return [target.base];
  return [
    target.base,
    ...(ports ?? SUGGESTED_HIGH_PORTS).map((port) => withPort(target.base, port)),
  ];
}

function isSingleCandidate(target: ProbeTarget): boolean {
  return target.explicitPort !== null || isLoopbackHostname(new URL(target.base).hostname);
}

const HEALTH_PATH: Record<ProbeKind, string> = {
  relay: '/api/relay/health',
  hub: '/healthz',
};

/** 健康判据与各自的既有调用方一致：中继看 `ok`，Hub 看 `status`。 */
function isHealthyBody(kind: ProbeKind, body: unknown): boolean {
  const payload = body as { ok?: unknown; status?: unknown } | null;
  if (!payload || typeof payload !== 'object') return false;
  return kind === 'relay' ? payload.ok === true : payload.status === 'ok';
}

async function checkOne(
  url: string,
  options: ProbeAddressPortsOptions,
  outer: AbortSignal
): Promise<boolean> {
  const dial = options.resolveDialUrl ? options.resolveDialUrl(url) : url;
  const request = `${dial.replace(/\/+$/, '')}${HEALTH_PATH[options.kind]}`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, outer]);
  try {
    const res = await (options.fetchImpl ?? fetch)(request, { signal, redirect: 'error' });
    if (!res.ok) return false;
    return isHealthyBody(options.kind, await res.json());
  } catch {
    return false;
  }
}

interface Won {
  url: string;
  port: number;
}

/** 第一个探通的胜出；全部失败才回 `null`。 */
function firstHealthy(tasks: Promise<Won | null>[]): Promise<Won | null> {
  return new Promise((resolve) => {
    let pending = tasks.length;
    if (pending === 0) {
      resolve(null);
      return;
    }
    const settle = (won: Won | null) => {
      if (won) resolve(won);
      else if (--pending === 0) resolve(null);
    };
    for (const task of tasks) task.then(settle, () => settle(null));
  });
}

/** 443 的宽限期：它先回就直接用；回得慢或已经失败则立刻放候选表进场。 */
function withinGrace(task: Promise<Won | null>, graceMs: number): Promise<Won | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), graceMs);
    const done = (won: Won | null) => {
      clearTimeout(timer);
      resolve(won);
    };
    task.then(done, () => done(null));
  });
}

function delayed(ms: number, run: () => Promise<Won | null>): Promise<Won | null> {
  if (ms <= 0) return run();
  return new Promise((resolve) => {
    setTimeout(() => resolve(run()), ms);
  });
}

/**
 * 显式端口只确认不改；没写端口时先单探默认端口，宽限期内没结果才错开启动候选表，
 * 默认端口继续在跑——它迟到胜出仍然优先于沉默的候选。
 */
export async function probeAddressPorts(
  hostOrUrl: string,
  options: ProbeAddressPortsOptions
): Promise<PortProbeResult> {
  const target = parseProbeTarget(hostOrUrl);
  const explicit = target.explicitPort !== null;
  const abort = new AbortController();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener('abort', () => abort.abort(), { once: true });

  const triedPorts: number[] = [];
  let settled = false;
  const attempt = async (url: string, port: number): Promise<Won | null> => {
    if (settled || abort.signal.aborted) return null;
    triedPorts.push(port);
    return (await checkOne(url, options, abort.signal)) ? { url, port } : null;
  };
  const finish = (won: Won | null): PortProbeResult => {
    settled = true;
    abort.abort();
    return {
      url: won?.url ?? null,
      port: won?.port ?? null,
      explicit,
      triedPorts: [...triedPorts],
    };
  };

  const primary = attempt(target.base, target.port);
  if (isSingleCandidate(target)) return finish(await primary);

  const early = await withinGrace(primary, options.graceMs ?? PROBE_DEFAULT_GRACE_MS);
  if (early) return finish(early);

  const stagger = options.staggerMs ?? PROBE_DEFAULT_STAGGER_MS;
  const tasks = [primary];
  for (const [index, port] of (options.ports ?? SUGGESTED_HIGH_PORTS).entries()) {
    tasks.push(delayed(index * stagger, () => attempt(withPort(target.base, port), port)));
  }
  return finish(await firstHealthy(tasks));
}

type SuggestedPort = (typeof SUGGESTED_HIGH_PORTS)[number];

function pickFrom(ports: readonly SuggestedPort[], rng: () => number): SuggestedPort {
  const index = Math.floor(rng() * ports.length);
  return ports[Math.min(ports.length - 1, Math.max(0, index))] as SuggestedPort;
}

/** 从内置候选里随机取一个；`rng` 可注入，便于测试固定结果。 */
export function pickSuggestedPort(rng: () => number = Math.random): SuggestedPort {
  return pickFrom(SUGGESTED_HIGH_PORTS, rng);
}

/** 取一个建议端口，避开本机已占用的端口（gateway / peer / tls）；全被占用时退回全表。 */
export function pickSuggestedPortAvoiding(
  used: readonly number[],
  rng: () => number = Math.random
): SuggestedPort {
  const free = SUGGESTED_HIGH_PORTS.filter((port) => !used.includes(port));
  return pickFrom(free.length > 0 ? free : SUGGESTED_HIGH_PORTS, rng);
}
