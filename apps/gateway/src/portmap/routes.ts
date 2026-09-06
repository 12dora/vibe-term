import type {
  CreatePortMapExportRequest,
  CreatePortMapRequest,
  PortMapExportDto,
  UpdatePortMapRequest,
} from '@tmex/shared';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { getDb } from '../db/client';
import { type PortMapManager, portMapManager } from './manager';
import { isPortListening } from './port-probe';
import { PortMapExportStore, type PortMapExportStoreLike } from './store';
import {
  PortMapError,
  type PortMapExportRow,
  assertHost,
  assertMapId,
  assertName,
  assertNodeId,
  assertPort,
  portMapHttpStatus,
} from './types';

type Deps = {
  manager: () => PortMapManager;
  exports: () => PortMapExportStoreLike;
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
  };
}

function parseUpdate(body: Record<string, unknown>): UpdatePortMapRequest {
  const patch: UpdatePortMapRequest = {};
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

function exportRoutes(deps: Deps): ApiRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/portmap/exports',
      handler: () => json({ exports: deps.exports().list().map(toExportDto) }),
    }),
    route({
      method: 'POST',
      path: '/api/portmap/exports',
      handler: async (req) => {
        try {
          const input = parseCreateExport(await jsonBody(req));
          const row: PortMapExportRow = {
            mapId: input.mapId ?? randomMapId(),
            fromNodeId: input.fromNodeId,
            host: input.host ?? '127.0.0.1',
            port: input.port,
            enabled: true,
            createdAt: Date.now(),
          };
          deps.exports().insert(row);
          return json({ export: toExportDto(row) }, 201);
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
      handler: (_req, params) => {
        try {
          deps.manager().remove(params.id);
          return json({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      },
    }),
  ];
}

let exportStore: PortMapExportStoreLike | null = null;

function defaultExportStore(): PortMapExportStoreLike {
  exportStore ??= new PortMapExportStore(getDb());
  return exportStore;
}

export function createPortMapRoutes(deps: Partial<Deps> = {}): ApiRoute[] {
  const resolved: Deps = {
    manager: deps.manager ?? portMapManager,
    exports: deps.exports ?? defaultExportStore,
  };
  return [
    ...probeRoutes(resolved),
    ...exportRoutes(resolved),
    ...listRoutes(resolved),
    ...itemRoutes(resolved),
  ];
}

export const portMapRoutes: ApiRoute[] = createPortMapRoutes();
