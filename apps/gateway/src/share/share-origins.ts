import {
  type ShareOriginCandidate,
  isPublicShareOrigin,
  nodeSharePrefix,
  normalizeShareOrigin,
  rankShareOrigins,
} from '@vibeterm/shared/share';
import { asc, eq } from 'drizzle-orm';
import { getSiteSettingsLinkProvider } from '../api/site-settings-link';
import { config } from '../config';
import { getStoredSiteSettings } from '../db';
import { getDb as getOrmDb } from '../db/client';
import { meshHubs, meshRelays, nodeIdentity } from '../db/schema';
import { TunnelConfigStore } from '../tunnel/config-store';
import { tunnelManager } from '../tunnel/manager';
import { RelayEntryProbe, type RelayProbeState } from './relay-entry-probe';

export type ShareOriginContext = {
  candidates: ShareOriginCandidate[];
  /** 规范化 origin → 该地址访问本节点所需的路径前缀（`/n/<nodeId>` 或 null）。 */
  prefixes: Map<string, string | null>;
  nodePrefix: string | null;
};

export type ShareOriginRelayRow = {
  url: string;
  priority: number;
  attached: boolean;
  /** 中继主机是否同时担任 node（转发 `/n/<id>/*`）。变化时作废探测含失败次数。 */
  node?: boolean;
};

export type ShareOriginProbe = {
  state(url: string): RelayProbeState;
  ensure(url: string): void;
  invalidate(url: string, options?: { resetStreak?: boolean }): void;
};

export type ShareOriginSources = {
  localNodeId(): string | null;
  hubs(): Array<{ hubNodeId: string; publicUrl: string; name: string | null }>;
  siteUrl(): string | null;
  /** 站点 URL 由 hub 托管：此时存储值只是历史残留，不作为候选。 */
  siteUrlManaged(): boolean;
  tunnelUrl(): string | null;
  baseUrl(): string | null;
  uplinkKind(): 'hub' | 'relay' | null;
  relays(): ShareOriginRelayRow[];
  relayProbe(): ShareOriginProbe;
};

function labelOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function readLocalNodeId(): string | null {
  try {
    const row = getOrmDb()
      .select({ nodeId: nodeIdentity.nodeId })
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, 1))
      .get();
    return row?.nodeId ?? null;
  } catch {
    return null;
  }
}

function readHubs(): Array<{ hubNodeId: string; publicUrl: string; name: string | null }> {
  try {
    return getOrmDb()
      .select({
        hubNodeId: meshHubs.hubNodeId,
        publicUrl: meshHubs.publicUrl,
        name: meshHubs.name,
      })
      .from(meshHubs)
      .all();
  } catch {
    return [];
  }
}

function readSiteUrl(): string | null {
  try {
    return getStoredSiteSettings().siteUrl || null;
  } catch {
    return null;
  }
}

function readSiteUrlManaged(): boolean {
  try {
    return getSiteSettingsLinkProvider().siteUrlManaged();
  } catch {
    return false;
  }
}

function readUplinkKind(): 'hub' | 'relay' | null {
  try {
    const row = getOrmDb()
      .select({ uplinkKind: nodeIdentity.uplinkKind })
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, 1))
      .get();
    if (!row) return null;
    return row.uplinkKind === 'relay' ? 'relay' : 'hub';
  } catch {
    return null;
  }
}

let attachedUplinkUrl: (() => string | null) | null = null;
let lastAttachedRelay: { url: string; node: boolean } | null = null;

/** 由装配层注入：当前 uplink 实际连上的中继 / hub 公网地址（用于把在用中继排到候选前面）。 */
export function setShareOriginAttachedUplink(resolver: (() => string | null) | null): void {
  attachedUplinkUrl = resolver;
  lastAttachedRelay = null;
  relayAccessCache = null;
}

function readAttachedUplinkUrl(): string | null {
  try {
    return attachedUplinkUrl?.() ?? null;
  } catch {
    return null;
  }
}

function readRelays(): ShareOriginRelayRow[] {
  try {
    const attached = normalizeShareOrigin(readAttachedUplinkUrl() ?? '');
    return getOrmDb()
      .select({ url: meshRelays.url, priority: meshRelays.priority, kicked: meshRelays.kicked })
      .from(meshRelays)
      .orderBy(asc(meshRelays.priority))
      .all()
      .filter((row) => Boolean(row.url) && !row.kicked)
      .map((row) => ({
        url: row.url,
        priority: row.priority,
        attached: attached !== null && normalizeShareOrigin(row.url) === attached,
      }))
      .sort((left, right) => {
        if (left.attached !== right.attached) return left.attached ? -1 : 1;
        return left.priority - right.priority;
      });
  } catch {
    return [];
  }
}

function readTunnelUrl(): string | null {
  let hostname: string | null = null;
  try {
    const persisted = new TunnelConfigStore(getOrmDb()).get();
    if (persisted.mode === 'off') return null;
    hostname = persisted.hostname ?? null;
  } catch {
    hostname = null;
  }
  try {
    const status = tunnelManager.status();
    const live = status.process.publicUrl;
    if (live) return live;
    if (status.config.mode === 'off') return null;
    hostname = hostname ?? status.config.hostname ?? null;
  } catch {
    /* tunnel manager unavailable in unit tests */
  }
  return hostname ? `https://${hostname}` : null;
}

let sharedProbe: RelayEntryProbe | null = null;

function defaultRelayProbe(): RelayEntryProbe {
  if (!sharedProbe) sharedProbe = new RelayEntryProbe({ localNodeId: readLocalNodeId });
  return sharedProbe;
}

export const defaultShareOriginSources: ShareOriginSources = {
  localNodeId: readLocalNodeId,
  hubs: readHubs,
  siteUrl: readSiteUrl,
  siteUrlManaged: readSiteUrlManaged,
  tunnelUrl: readTunnelUrl,
  baseUrl: () => config.baseUrl || null,
  uplinkKind: readUplinkKind,
  relays: readRelays,
  relayProbe: defaultRelayProbe,
};

/**
 * 探一遍中继入口，免得第一次打开分享弹窗只看得到隧道地址。
 * 必须在 HTTP 监听与 mesh 上联起来之后调用：过早探测只会把 `bad` 写进缓存。
 */
export function primeShareRelayOrigins(
  sources: ShareOriginSources = defaultShareOriginSources
): void {
  if (sources.uplinkKind() !== 'relay') return;
  const probe = sources.relayProbe();
  const relays = sources.relays();
  invalidateOnAttachedChange(probe, relays);
  for (const relay of relays) probe.ensure(relay.url);
}

export const SHARE_RELAY_PRIME_DELAY_MS = 10_000;
export const SHARE_RELAY_PRIME_INTERVAL_MS = 5 * 60_000;

/**
 * 启动后延迟预热中继入口探测，并定期补探；返回停机时用的清理函数。
 * 不能在装配期跑：那会儿 HTTP 监听与 mesh 上联都还没起来，探测必失败并把 `bad` 缓存 2 min。
 */
export function startShareRelayPriming(
  sources: ShareOriginSources = defaultShareOriginSources
): () => void {
  const first = setTimeout(() => primeShareRelayOrigins(sources), SHARE_RELAY_PRIME_DELAY_MS);
  const repeat = setInterval(() => primeShareRelayOrigins(sources), SHARE_RELAY_PRIME_INTERVAL_MS);
  first.unref?.();
  repeat.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
  };
}

function attachedRelayWatch(relays: ShareOriginRelayRow[]): { url: string; node: boolean } | null {
  const attached = relays.find((row) => row.attached) ?? null;
  if (!attached) return null;
  const url = normalizeShareOrigin(attached.url);
  if (!url) return null;
  return { url, node: attached.node === true };
}

/**
 * 上联刚接上中继时，接上之前探到的 `bad` 必须立刻作废并重探，否则要干等退避才会出现中继候选。
 * 只丢 `bad`：`ok` 结论仍然成立，丢了反而让候选在切换瞬间凭空消失。
 * 同一条中继的 node 角色或公网 URL 变了则连 streak 一起清：退避是旧配置下的结论。
 */
function invalidateOnAttachedChange(probe: ShareOriginProbe, relays: ShareOriginRelayRow[]): void {
  const next = attachedRelayWatch(relays);
  const prev = lastAttachedRelay;
  if (prev?.url === next?.url && prev?.node === next?.node) return;
  lastAttachedRelay = next;
  if (!next) return;
  const nodeChanged = prev !== null && prev.url === next.url && prev.node !== next.node;
  if (nodeChanged || probe.state(next.url) === 'bad') {
    probe.invalidate(next.url, { resetStreak: true });
  }
}

function isIpHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host.startsWith('[')) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

type RawCandidate = {
  url: string;
  kind: ShareOriginCandidate['kind'];
  prefix: string | null;
  /** 是否进入排序后的候选列表（供自动选取 / 推荐）；前缀映射不受此位影响。 */
  listed: boolean;
};

/**
 * 中继原始候选恒定产出：`/n/<self>` 前缀是链路属性，不随探测状态漂移——
 * 否则探测过期的那一刻建分享就会存下 `https://<中继>/s/<id>` 这种死链。
 * 探测只决定要不要把它推荐给用户。
 */
function collectRelays(sources: ShareOriginSources, prefix: string | null): RawCandidate[] {
  if (!prefix || sources.uplinkKind() !== 'relay') return [];
  const probe = sources.relayProbe();
  const relays = sources.relays();
  invalidateOnAttachedChange(probe, relays);
  return relays.map((relay) => {
    probe.ensure(relay.url);
    return {
      url: relay.url,
      kind: 'relay' as const,
      prefix,
      listed: probe.state(relay.url) === 'ok',
    };
  });
}

function collectRaw(sources: ShareOriginSources): RawCandidate[] {
  const raw: RawCandidate[] = [];
  const localNodeId = sources.localNodeId();
  const prefix = localNodeId ? nodeSharePrefix(localNodeId) : null;

  const tunnel = sources.tunnelUrl();
  const site = sources.siteUrl();
  // 站点 URL 常被填成隧道域名；由 hub 托管时它更是历史残留，两种情况都由对应 kind 的候选代表。
  if (site && !sources.siteUrlManaged() && originOf(site) !== originOf(tunnel)) {
    raw.push({ url: site, kind: 'site', prefix: null, listed: true });
  }

  for (const hub of sources.hubs()) {
    if (!hub.publicUrl) continue;
    const ownHub = Boolean(localNodeId) && hub.hubNodeId === localNodeId;
    raw.push({ url: hub.publicUrl, kind: 'hub', prefix: ownHub ? null : prefix, listed: true });
  }

  raw.push(...collectRelays(sources, prefix));

  if (tunnel) raw.push({ url: tunnel, kind: 'tunnel', prefix: null, listed: true });

  const base = sources.baseUrl();
  if (base && isIpHost(base)) raw.push({ url: base, kind: 'ip', prefix: null, listed: true });

  return raw;
}

/**
 * 分享地址候选。中继只有同时担任 `node` 角色时才转发 `/n/<nodeId>/*`，故中继**候选列表**由可达性探测放行；
 * 前缀映射（`prefixes`）与自定义地址的前缀继承始终按链路事实给出，与探测状态无关。
 * 自定义地址来自设置里的默认分享地址，优先级最高。
 */
export function buildShareOriginContext(
  sources: ShareOriginSources = defaultShareOriginSources,
  customOrigin?: string | null
): ShareOriginContext {
  const raw = collectRaw(sources);
  const localNodeId = sources.localNodeId();
  const nodePrefix = localNodeId ? nodeSharePrefix(localNodeId) : null;
  if (customOrigin) {
    // 手填的地址若与某个转发型候选（hub / 中继）同主机，必须继承它的 `/n/<nodeId>` 前缀，否则是死链。
    const forwardPrefixes = new Map(
      raw
        .filter((item) => item.kind === 'hub' || item.kind === 'relay')
        .map((item) => [labelOf(item.url), item.prefix])
    );
    raw.unshift({
      url: customOrigin,
      kind: 'custom',
      prefix: forwardPrefixes.get(labelOf(customOrigin)) ?? null,
      listed: true,
    });
  }

  const prefixes = new Map<string, string | null>();
  for (const item of raw) {
    const normalized = normalizeShareOrigin(item.url);
    if (!normalized || prefixes.has(normalized)) continue;
    prefixes.set(normalized, item.prefix);
  }

  const ranked = rankShareOrigins(
    raw
      .filter((item) => item.listed)
      .map((item) => ({
        url: item.url,
        kind: item.kind,
        label: labelOf(item.url),
        accessUrl: item.url,
      }))
  );
  const candidates = ranked.map((candidate) => {
    const prefix = prefixes.get(candidate.url) ?? null;
    return { ...candidate, accessUrl: prefix ? `${candidate.url}${prefix}` : candidate.url };
  });
  return { candidates, prefixes, nodePrefix };
}

export function resolveSharePrefix(context: ShareOriginContext, origin: string): string | null {
  const normalized = normalizeShareOrigin(origin);
  if (!normalized) return null;
  return context.prefixes.get(normalized) ?? null;
}

const RELAY_ACCESS_URL_TTL_MS = 5_000;
let relayAccessCache: { value: string | null; expiresAt: number } | null = null;

/**
 * 当前可用的中继访问地址 `<relay>/n/<self>`；探测未通过（或不是中继上联）时为 null。
 * 站点 URL 兜底会在每次读设置时调用，故加 5 s 记忆化，避免高频重建候选上下文。
 */
export function relayShareAccessUrl(
  sources: ShareOriginSources = defaultShareOriginSources,
  now: number = Date.now()
): string | null {
  if (relayAccessCache && now < relayAccessCache.expiresAt) return relayAccessCache.value;
  const context = buildShareOriginContext(sources, null);
  const value = context.candidates.find((item) => item.kind === 'relay')?.accessUrl ?? null;
  relayAccessCache = { value, expiresAt: now + RELAY_ACCESS_URL_TTL_MS };
  return value;
}

export function isUsableShareOrigin(origin: string): boolean {
  return isPublicShareOrigin(origin);
}
