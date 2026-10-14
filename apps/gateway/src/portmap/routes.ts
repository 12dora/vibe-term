import {
  type CreatePortMapExportRequest,
  type CreatePortMapRequest,
  PORT_MAP_LEASE_DEFAULT_MS,
  type PortMapExportDto,
  type UpdatePortMapExportRequest,
  type UpdatePortMapRequest,
} from '@vibeterm/shared';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { requestPeerExportRemoval } from './export-cleanup';
import { type PortMapManager, portMapManager } from './manager';
import { isPortListening } from './port-probe';
import { type PortMapExportStoreLike, defaultPortMapExportStore } from './store';
import {
  PortMapError,
  type PortMapExportRow,
  assertHost,
  assertLeaseMs,
  assertMapId,
  assertName,
  assertNodeId,
  assertPort,
  isLeaseExpired,
  portMapHttpStatus,
} from './types';

type Deps = {
  manager: () => PortMapManager;
  exports: () => PortMapExportStoreLike;
  /** 删除映射时顺手清 B 的放行行；尽力而为，返回是否已清掉。 */
  removePeerExport: (nodeId: string, mapId: string) => Promise<boolean>;
  now: () => number;
};

/** 顶层再放一份 code：api-client 的 `toApiError` 只认顶层 `code` 字段。 */
function errorResponse(err: unknown): Response {
  if (err instanceof PortMapError) {
    return json(
      { error: { code: err.code, message: err.message }, code: err.code, message: err.message },
      portMapHttpStatus(err.code)
    );
  }
  const message = err instanceof Error ? err.message : 'port map request failed';
  return json(
    { error: { code: 'invalid_request', message }, code: 'invalid_request', message },
    400
  );
}

function toExportDto(row: PortMapExportRow): PortMapExportDto {
  return { ...row };
}

function randomMapId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function parseCreate(body: Record<string, unknown>): CreatePortMapRequest {
  return {
    ...(body.name === undefined ? {} : { name: assertName(body.name, 'name') }),
    ...(body.listenHost === undefined
      ? {}
      : { listenHost: assertHost(body.listenHost, 'listenHost') }),
    listenPort: assertPort(body.listenPort, 'listenPort'),
    targetNodeId: assertNodeId(body.targetNodeId, 'targetNodeId'),
    ...(body.targetHost === undefined
      ? {}
      : { targetHost: assertHost(body.targetHost, 'targetHost') }),
    targetPort: assertPort(body.targetPort, 'targetPort'),
    ...(body.mapId === undefined ? {} : { mapId: assertMapId(body.mapId, 'mapId') }),
    ...(body.leaseMs === undefined ? {} : { leaseMs: assertLeaseMs(body.leaseMs, 'leaseMs') }),
  };
}

function parseLeaseRenewal(
  body: Record<string, unknown>
): Pick<UpdatePortMapExportRequest, 'renewLease' | 'leaseMs'> {
  const patch: Pick<UpdatePortMapExportRequest, 'renewLease' | 'leaseMs'> = {};
  if (body.renewLease !== undefined) {
    if (typeof body.renewLease !== 'boolean') {
      throw new PortMapError('invalid_request', 'renewLease must be a boolean');
    }
    patch.renewLease = body.renewLease;
  }
  if (body.leaseMs !== undefined) patch.leaseMs = assertLeaseMs(body.leaseMs, 'leaseMs');
  return patch;
}

function parseUpdate(body: Record<string, unknown>): UpdatePortMapRequest {
  const patch: UpdatePortMapRequest = parseLeaseRenewal(body);
  if (body.name !== undefined) patch.name = assertName(body.name, 'name');
  if (body.paused !== undefined) {
    if (typeof body.paused !== 'boolean') {
      throw new PortMapError('invalid_request', 'paused must be a boolean');
    }
    patch.paused = body.paused;
  }
  return patch;
}

function parseCreateExport(body: Record<string, unknown>): CreatePortMapExportRequest {
  return {
    ...(body.mapId === undefined ? {} : { mapId: assertMapId(body.mapId, 'mapId') }),
    fromNodeId: assertNodeId(body.fromNodeId, 'fromNodeId'),
    ...(body.host === undefined ? {} : { host: assertHost(body.host, 'host') }),
    port: assertPort(body.port, 'port'),
    ...(body.leaseMs === undefined ? {} : { leaseMs: assertLeaseMs(body.leaseMs, 'leaseMs') }),
  };
}

function queryHostPort(req: Request): { host: string; port: number } {
  const url = new URL(req.url);
  const host = url.searchParams.get('host') ?? '127.0.0.1';
  const rawPort = Number(url.searchParams.get('port'));
  return { host: assertHost(host, 'host'), port: assertPort(rawPort, 'port') };
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body = await readJsonObjectBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PortMapError('invalid_request', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function listRoutes(deps: Deps): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/portmap',
      handler: () => json({ maps: deps.manager().list() }),
    }),
    route({
      method: 'POST',
      path: '/api/portmap',
      handler: async (req) => {
        try {
          const map = deps.manager().create(parseCreate(await jsonBody(req)));
          return json({ map }, 201);
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
  ];
}

function probeRoutes(deps: Deps): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/portmap/probe',
      handler: (req) => {
        try {
          const { host, port } = queryHostPort(req);
          return json(deps.manager().probe(host, port));
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
    route({
      method: 'GET',
      path: '/api/portmap/target-probe',
      handler: async (req) => {
        try {
          const { host, port } = queryHostPort(req);
          return json({ host, port, listening: await isPortListening(host, port) });
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
  ];
}

/** 续约放行行：已过期的当场回收并视为不存在；`renewLease` 不会把持久放行变成带租约。 */
function renewExport(
  deps: Deps,
  mapId: string,
  patch: Pick<UpdatePortMapExportRequest, 'renewLease' | 'leaseMs'>
): PortMapExportDto {
  const store = deps.exports();
  const now = deps.now();
  const row = store.get(mapId);
  if (row && isLeaseExpired(row, now)) store.remove(mapId);
  if (!row || isLeaseExpired(row, now)) {
    throw new PortMapError('not_found', `port map export ${mapId} not found`);
  }
  let leaseExpiresAt = row.leaseExpiresAt;
  if (patch.leaseMs !== undefined) leaseExpiresAt = now + patch.leaseMs;
  else if (patch.renewLease === true && leaseExpiresAt !== undefined) {
    leaseExpiresAt = now + PORT_MAP_LEASE_DEFAULT_MS;
  }
  const next: PortMapExportRow = {
    ...row,
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
  };
  store.insert(next);
  return toExportDto(next);
}

function exportRoutes(deps: Deps): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/portmap/exports',
      handler: () => {
        const now = deps.now();
        const live = deps
          .exports()
          .list()
          .filter((row) => !isLeaseExpired(row, now));
        return json({ exports: live.map(toExportDto) });
      },
    }),
    route({
      method: 'POST',
      path: '/api/portmap/exports',
      handler: async (req) => {
        try {
          const input = parseCreateExport(await jsonBody(req));
          const now = deps.now();
          const row: PortMapExportRow = {
            mapId: input.mapId ?? randomMapId(),
            fromNodeId: input.fromNodeId,
            host: input.host ?? '127.0.0.1',
            port: input.port,
            enabled: true,
            createdAt: now,
            ...(input.leaseMs === undefined ? {} : { leaseExpiresAt: now + input.leaseMs }),
          };
          deps.exports().insert(row);
          return json({ export: toExportDto(row) }, 201);
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
    route({
      method: 'PATCH',
      path: '/api/portmap/exports/:mapId',
      handler: async (req, params) => {
        try {
          const patch = parseLeaseRenewal(await jsonBody(req));
          return json({ export: renewExport(deps, params.mapId, patch) });
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/portmap/exports/:mapId',
      handler: (_req, params) => {
        deps.exports().remove(params.mapId);
        return json({ ok: true });
      },
    }),
  ];
}

function itemRoutes(deps: Deps): ApiRoute[] {
  return [
    route({
      method: 'PATCH',
      path: '/api/portmap/:id',
      handler: async (req, params) => {
        try {
          return json({ map: deps.manager().update(params.id, parseUpdate(await jsonBody(req))) });
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/portmap/:id',
      handler: async (_req, params) => {
        let targetNodeId: string;
        try {
          targetNodeId = deps.manager().get(params.id).targetNodeId;
          deps.manager().remove(params.id);
        } catch (err) {
          return errorResponse(err);
        }
        return json({
          ok: true,
          exportRemoved: await deps.removePeerExport(targetNodeId, params.id),
        });
      },
    }),
  ];
}

export function createPortMapRoutes(deps: Partial<Deps> = {}): ApiRoute[] {
  const resolved: Deps = {
    manager: deps.manager ?? portMapManager,
    exports: deps.exports ?? defaultPortMapExportStore,
    removePeerExport: deps.removePeerExport ?? requestPeerExportRemoval,
    now: deps.now ?? Date.now,
  };
  return [
    ...probeRoutes(resolved),
    ...exportRoutes(resolved),
    ...listRoutes(resolved),
    ...itemRoutes(resolved),
  ];
}

export const portMapRoutes: ApiRoute[] = createPortMapRoutes();
