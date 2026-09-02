import { eq } from 'drizzle-orm';
import { config } from '../config';
import { getSiteSettings } from '../db';
import { getDb as getOrmDb } from '../db/client';
import { type DomainAccessStore, domainAccessStore } from '../db/domain-access';
import { meshHubs, nodeIdentity } from '../db/schema';
import {
  collectConfiguredHosts,
  decideDomainAccess,
  isViaDomain,
} from '../mesh/domain-access-policy';
import { MESH_VIA_SELF, getMeshRequestContext } from '../mesh/mesh-deps';
import { publicRequestUrl } from '../mesh/session-middleware';
import { TunnelConfigStore } from '../tunnel/config-store';
import { tunnelManager } from '../tunnel/manager';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

export const DOMAIN_ACCESS_DISABLED = 'DOMAIN_ACCESS_DISABLED';
export const DOMAIN_ACCESS_DISABLED_JSON_MESSAGE =
  'Access through this domain is disabled for this node.';
export const DOMAIN_ACCESS_DISABLED_TEXT = 'Domain access is disabled for this host.';

export type DomainAccessView = {
  allowed: boolean;
  viaDomain: boolean;
  hosts: string[];
};

type GuardOverride = {
  allowed?: boolean;
  hosts?: string[];
} | null;

let guardOverride: GuardOverride = null;
let storeOverride: DomainAccessStore | null = null;

export function setDomainAccessGuardForTests(override: GuardOverride): void {
  guardOverride = override;
}

export function setDomainAccessStoreForTests(store: DomainAccessStore | null): void {
  storeOverride = store;
}

export function resetDomainAccessForTests(): void {
  guardOverride = null;
  storeOverride = null;
}

function activeStore(): DomainAccessStore {
  return storeOverride ?? domainAccessStore;
}

function readAllowed(): boolean {
  if (guardOverride?.allowed !== undefined) return guardOverride.allowed;
  try {
    return activeStore().get().allowDomainAccess;
  } catch {
    return true;
  }
}

function selfMeshHubPublicUrl(): string | null {
  try {
    const db = getOrmDb();
    const identity = db
      .select({ nodeId: nodeIdentity.nodeId })
      .from(nodeIdentity)
      .where(eq(nodeIdentity.id, 1))
      .get();
    if (!identity?.nodeId) return null;
    const hub = db
      .select({ publicUrl: meshHubs.publicUrl })
      .from(meshHubs)
      .where(eq(meshHubs.hubNodeId, identity.nodeId))
      .get();
    return hub?.publicUrl ?? null;
  } catch {
    return null;
  }
}

export function listDomainAccessHosts(): string[] {
  if (guardOverride?.hosts) return [...guardOverride.hosts];
  const sources: Array<string | null | undefined> = [config.baseUrl];
  try {
    sources.push(getSiteSettings().siteUrl);
  } catch {
    /* site_settings may be missing in unit tests */
  }
  if (config.roles.hub) {
    sources.push(config.hubPublicUrl);
    sources.push(selfMeshHubPublicUrl());
  }
  try {
    const persisted = new TunnelConfigStore(getOrmDb()).get();
    sources.push(persisted.hostname);
  } catch {
    /* tunnel_config may be missing */
  }
  try {
    sources.push(tunnelManager.status().process.publicUrl);
  } catch {
    /* tunnel manager unread in some tests */
  }
  return collectConfiguredHosts(sources);
}

export function buildDomainAccessView(req: Request): DomainAccessView {
  const allowed = readAllowed();
  const hosts = listDomainAccessHosts();
  const viaSelf = getMeshRequestContext(req).via === MESH_VIA_SELF;
  const viaDomain = viaSelf && isViaDomain(publicRequestUrl(req), hosts);
  return { allowed, viaDomain, hosts };
}

export function guardDomainAccess(req: Request): Response | null {
  const viaSelf = getMeshRequestContext(req).via === MESH_VIA_SELF;
  const allowed = readAllowed();
  if (!viaSelf || allowed) return null;
  const hosts = listDomainAccessHosts();
  const decision = decideDomainAccess({
    viaSelf,
    allowed,
    hosts,
    effectiveUrl: publicRequestUrl(req),
    method: req.method,
    pathname: new URL(req.url).pathname,
  });
  if (decision === 'allow') return null;
  if (decision === 'deny-json') {
    return json(
      {
        error: {
          code: DOMAIN_ACCESS_DISABLED,
          message: DOMAIN_ACCESS_DISABLED_JSON_MESSAGE,
        },
      },
      403
    );
  }
  return new Response(DOMAIN_ACCESS_DISABLED_TEXT, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

async function handleGet(req: Request): Promise<Response> {
  return json(buildDomainAccessView(req));
}

async function handlePatch(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body || typeof body.allowed !== 'boolean') {
    return json({ error: { code: 'INVALID_BODY', message: 'allowed must be a boolean' } }, 400);
  }
  activeStore().set(body.allowed);
  return json(buildDomainAccessView(req));
}

export const domainAccessRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/system/domain-access',
    handler: (req) => handleGet(req),
  }),
  route({
    method: 'PATCH',
    path: '/api/system/domain-access',
    handler: (req) => handlePatch(req),
  }),
];
