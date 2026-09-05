import {
  type ShareOriginCandidate,
  isPublicShareOrigin,
  nodeSharePrefix,
  normalizeShareOrigin,
  rankShareOrigins,
} from '@tmex/shared/share';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { getStoredSiteSettings } from '../db';
import { getDb as getOrmDb } from '../db/client';
import { meshHubs, nodeIdentity } from '../db/schema';
import { TunnelConfigStore } from '../tunnel/config-store';
import { tunnelManager } from '../tunnel/manager';

export type ShareOriginContext = {
  candidates: ShareOriginCandidate[];
  /** 规范化 origin → 该地址访问本节点所需的路径前缀（`/n/<nodeId>` 或 null）。 */
  prefixes: Map<string, string | null>;
  nodePrefix: string | null;
};

export type ShareOriginSources = {
  localNodeId(): string | null;
  hubs(): Array<{ hubNodeId: string; publicUrl: string; name: string | null }>;
  siteUrl(): string | null;
  tunnelUrl(): string | null;
  baseUrl(): string | null;
};

function labelOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
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

export const defaultShareOriginSources: ShareOriginSources = {
  localNodeId: readLocalNodeId,
  hubs: readHubs,
  siteUrl: readSiteUrl,
  tunnelUrl: readTunnelUrl,
  baseUrl: () => config.baseUrl || null,
};

function isIpHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host.startsWith('[')) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

type RawCandidate = { url: string; kind: ShareOriginCandidate['kind']; prefix: string | null };

function collectRaw(sources: ShareOriginSources): RawCandidate[] {
  const raw: RawCandidate[] = [];
  const localNodeId = sources.localNodeId();
  const prefix = localNodeId ? nodeSharePrefix(localNodeId) : null;

  const site = sources.siteUrl();
  if (site) raw.push({ url: site, kind: 'site', prefix: null });

  for (const hub of sources.hubs()) {
    if (!hub.publicUrl) continue;
    const ownHub = Boolean(localNodeId) && hub.hubNodeId === localNodeId;
    raw.push({ url: hub.publicUrl, kind: 'hub', prefix: ownHub ? null : prefix });
  }

  const tunnel = sources.tunnelUrl();
  if (tunnel) raw.push({ url: tunnel, kind: 'tunnel', prefix: null });

  const base = sources.baseUrl();
  if (base && isIpHost(base)) raw.push({ url: base, kind: 'ip', prefix: null });

  return raw;
}

/**
 * 分享地址候选。中继在本项目里是盲字节转发，浏览器无法经中继直达节点，故不产生 `relay` 候选。
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
    const hubPrefixes = new Map(
      raw.filter((item) => item.kind === 'hub').map((item) => [labelOf(item.url), item.prefix])
    );
    raw.unshift({
      url: customOrigin,
      kind: 'custom',
      prefix: hubPrefixes.get(labelOf(customOrigin)) ?? null,
    });
  }

  const prefixes = new Map<string, string | null>();
  for (const item of raw) {
    const normalized = normalizeShareOrigin(item.url);
    if (!normalized || prefixes.has(normalized)) continue;
    prefixes.set(normalized, item.prefix);
  }

  const candidates = rankShareOrigins(
    raw.map((item) => ({ url: item.url, kind: item.kind, label: labelOf(item.url) }))
  );
  return { candidates, prefixes, nodePrefix };
}

export function resolveSharePrefix(context: ShareOriginContext, origin: string): string | null {
  const normalized = normalizeShareOrigin(origin);
  if (!normalized) return null;
  return context.prefixes.get(normalized) ?? null;
}

export function isUsableShareOrigin(origin: string): boolean {
  return isPublicShareOrigin(origin);
}
