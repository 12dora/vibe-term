import { readJsonObjectBody } from '@tmex/shared/http';
import { type HttpMethod, matchPath, methodMatches } from '../api/route';
import { RelayErrorCode, relayError } from './relay-http';
import {
  applyRelayKeyLogAppend,
  applyRelayPackUpload,
  handleRelayKeyLogPage,
  handleRelayTenantKdf,
} from './relay-pack-http';
import {
  type RelayPublicRoutesDeps,
  authenticateRelayTenant,
  handleRelayEnroll,
  handleRelayEnrollmentLookup,
  handleRelayRedeem,
  relayHealth,
} from './relay-routes';

export type RelayPublicDispatchCtx = {
  deps: RelayPublicRoutesDeps;
  version: string;
  startedAt: number;
  tenantCount: () => number;
  nodesOnline: () => number;
  now: () => number;
};

type PublicRoute = {
  pattern: string;
  methods: HttpMethod | readonly HttpMethod[] | '*';
  handle: (
    ctx: RelayPublicDispatchCtx,
    req: Request,
    params: Record<string, string>
  ) => Promise<Response> | Response;
};

function tenantParam(params: Record<string, string>): string {
  return decodeURIComponent(params.tenantId ?? '');
}

async function handlePack(
  ctx: RelayPublicDispatchCtx,
  req: Request,
  params: Record<string, string>
): Promise<Response> {
  const tenant = authenticateRelayTenant(ctx.deps, req, tenantParam(params));
  if (tenant instanceof Response) return tenant;
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  return applyRelayPackUpload(ctx.deps, tenant, body);
}

async function handleKeyLog(
  ctx: RelayPublicDispatchCtx,
  req: Request,
  params: Record<string, string>
): Promise<Response> {
  const tenant = authenticateRelayTenant(ctx.deps, req, tenantParam(params));
  if (tenant instanceof Response) return tenant;
  if (req.method === 'GET' || req.method === 'HEAD') {
    return handleRelayKeyLogPage(ctx.deps, tenant, req);
  }
  if (req.method !== 'POST') return relayError(RelayErrorCode.methodNotAllowed, 405);
  const body = await readJsonObjectBody(req);
  if (!body) return relayError(RelayErrorCode.invalidBody, 400);
  return applyRelayKeyLogAppend(ctx.deps, tenant, body);
}

const RELAY_PUBLIC_ROUTES: readonly PublicRoute[] = [
  {
    pattern: '/api/relay/health',
    methods: ['GET', 'HEAD'],
    handle: (ctx) =>
      relayHealth({
        version: ctx.version,
        tenants: ctx.tenantCount(),
        nodesOnline: ctx.nodesOnline(),
        startedAt: ctx.startedAt,
        now: ctx.now(),
      }),
  },
  {
    pattern: '/api/relay/enroll',
    methods: 'POST',
    handle: (ctx, req) => handleRelayEnroll(ctx.deps, req),
  },
  {
    pattern: '/api/relay/tenants/:tenantId/kdf',
    methods: ['GET', 'HEAD'],
    handle: (ctx, req, params) => handleRelayTenantKdf(ctx.deps, req, tenantParam(params)),
  },
  {
    pattern: '/api/relay/tenants/:tenantId/pack',
    methods: 'POST',
    handle: handlePack,
  },
  {
    pattern: '/api/relay/tenants/:tenantId/keylog',
    methods: '*',
    handle: handleKeyLog,
  },
  {
    pattern: '/api/relay/tenants/:tenantId/enrollments/redeem',
    methods: 'POST',
    handle: (ctx, req, params) => handleRelayRedeem(ctx.deps, req, tenantParam(params)),
  },
  {
    pattern: '/api/relay/tenants/:tenantId/enrollments/:enrollPk',
    methods: 'GET',
    handle: (ctx, req, params) =>
      handleRelayEnrollmentLookup(
        ctx.deps,
        req,
        tenantParam(params),
        decodeURIComponent(params.enrollPk ?? '')
      ),
  },
];

/** 公开 `/api/relay/*` 路由表；未命中返回 undefined，交给管理路由。 */
export function dispatchRelayPublic(
  ctx: RelayPublicDispatchCtx,
  req: Request,
  path: string
): Promise<Response> | Response | undefined {
  for (const entry of RELAY_PUBLIC_ROUTES) {
    const params = matchPath(path, entry.pattern);
    if (!params) continue;
    if (!methodMatches(req.method, entry.methods)) {
      return relayError(RelayErrorCode.methodNotAllowed, 405);
    }
    return entry.handle(ctx, req, params);
  }
  return undefined;
}
