// forward 单测共用的假网关：内存里记账端口映射与放行行，支持租约与「旧版网关」两种形态。不进 bundle。

import type { FetchLike } from '../core/http';
import type { PortMapDto } from '../core/portmap-ops';
import { jsonResponse } from './cli-test-harness';
import type { ForwardEntry } from './forward';

export const NODE_A = 'a'.repeat(32);
export const NODE_B = 'b'.repeat(32);

export interface Call {
  method: string;
  node: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface FakeOptions {
  /** 第 n 次（从 1 起）创建映射时返回 409 port_in_use。 */
  failMapCreate?: number;
  stale?: Array<{ node: string; map: Partial<PortMapDto> }>;
  /** 哪些节点的网关认租约；缺省全部认。旧版网关 = 不认（忽略 leaseMs，也没有放行 PATCH 路由）。 */
  legacyNodes?: string[];
  /** 假时钟，租约到期时间 = now + leaseMs。 */
  now?: number;
}

export function mapDto(body: Record<string, unknown>): PortMapDto {
  return {
    id: String(body.mapId),
    name: String(body.name ?? ''),
    listenHost: String(body.listenHost),
    listenPort: Number(body.listenPort),
    targetNodeId: String(body.targetNodeId),
    targetHost: String(body.targetHost),
    targetPort: Number(body.targetPort),
    paused: false,
    state: 'listening',
    activeConnections: 0,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

type Body = Record<string, unknown> | null;

interface FakeState {
  options: FakeOptions;
  now: number;
  maps: Map<string, PortMapDto[]>;
  exportLeases: Map<string, number | undefined>;
  exportSeq: number;
  createSeq: number;
}

interface Req {
  node: string;
  body: Body;
  params: string[];
}

interface FakeRoute {
  method: string;
  pattern: RegExp;
  handle: (state: FakeState, req: Req) => Response;
}

const notFound = () => jsonResponse({ error: 'not_found' }, 404);

function supportsLeases(state: FakeState, node: string): boolean {
  return !(state.options.legacyNodes ?? []).includes(node);
}

function leaseOf(state: FakeState, node: string, body: Body): { leaseExpiresAt?: number } {
  const leaseMs = body?.leaseMs;
  if (!supportsLeases(state, node) || typeof leaseMs !== 'number') return {};
  return { leaseExpiresAt: state.now + leaseMs };
}

const nodeList = () =>
  jsonResponse({
    nodes: [
      { id: NODE_A, name: 'office', publicKey: 'x', online: true, loggedIn: true },
      { id: NODE_B, name: 'lab', publicKey: 'y', online: true, loggedIn: true },
    ],
  });

function createExport(state: FakeState, req: Req): Response {
  state.exportSeq += 1;
  const mapId = `m${state.exportSeq}`;
  const lease = leaseOf(state, req.node, req.body);
  state.exportLeases.set(mapId, lease.leaseExpiresAt);
  const { leaseMs: _ignored, ...rest } = req.body ?? {};
  return jsonResponse({ export: { mapId, ...rest, enabled: true, createdAt: 1, ...lease } });
}

function renewExport(state: FakeState, req: Req): Response {
  const mapId = req.params[0];
  if (!supportsLeases(state, req.node) || !state.exportLeases.has(mapId)) return notFound();
  return jsonResponse({ export: { mapId, ...leaseOf(state, req.node, req.body) } });
}

function createMap(state: FakeState, req: Req): Response {
  const body = req.body;
  if (!body) return notFound();
  state.createSeq += 1;
  const list = state.maps.get(req.node) ?? [];
  const clash = list.some(
    (row) => row.listenHost === body.listenHost && row.listenPort === body.listenPort
  );
  if (clash || state.options.failMapCreate === state.createSeq) {
    return jsonResponse({ error: { code: 'port_in_use', message: 'occupied' } }, 409);
  }
  const dto = { ...mapDto(body), ...leaseOf(state, req.node, body) };
  state.maps.set(req.node, [...list, dto]);
  return jsonResponse({ map: dto });
}

function deleteMap(state: FakeState, req: Req): Response {
  const list = state.maps.get(req.node) ?? [];
  state.maps.set(
    req.node,
    list.filter((row) => row.id !== req.params[0])
  );
  return jsonResponse({ ok: true, exportRemoved: true });
}

function renewMap(state: FakeState, req: Req): Response {
  const found = (state.maps.get(req.node) ?? []).find((row) => row.id === req.params[0]);
  if (!found) return notFound();
  Object.assign(found, leaseOf(state, req.node, req.body));
  return jsonResponse({ map: found });
}

const ROUTES: FakeRoute[] = [
  { method: 'GET', pattern: /^\/api\/mesh\/nodes$/, handle: nodeList },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/mode$/,
    handle: () => jsonResponse({ mode: 'mesh', nodeId: NODE_A }),
  },
  { method: 'POST', pattern: /^\/api\/portmap\/exports$/, handle: createExport },
  {
    method: 'DELETE',
    pattern: /^\/api\/portmap\/exports\/([^/]+)$/,
    handle: () => new Response(null, { status: 204 }),
  },
  { method: 'PATCH', pattern: /^\/api\/portmap\/exports\/([^/]+)$/, handle: renewExport },
  { method: 'POST', pattern: /^\/api\/portmap$/, handle: createMap },
  {
    method: 'GET',
    pattern: /^\/api\/portmap$/,
    handle: (state, req) => jsonResponse({ maps: state.maps.get(req.node) ?? [] }),
  },
  { method: 'DELETE', pattern: /^\/api\/portmap\/([^/]+)$/, handle: deleteMap },
  { method: 'PATCH', pattern: /^\/api\/portmap\/([^/]+)$/, handle: renewMap },
];

function seedStale(state: FakeState): void {
  for (const row of state.options.stale ?? []) {
    const list = state.maps.get(row.node) ?? [];
    list.push({ ...mapDto({ mapId: 'stale1', ...row.map }), ...row.map } as PortMapDto);
    state.maps.set(row.node, list);
  }
}

async function parseRequest(
  input: string,
  init: unknown
): Promise<{ call: Call; method: string; req: Omit<Req, 'params'> }> {
  const request = new Request(input, init as RequestInit);
  const url = new URL(request.url);
  const match = /^\/n\/([0-9a-f]{32})(\/.*)$/.exec(url.pathname);
  const node = match ? match[1] : 'self';
  const path = match ? match[2] : url.pathname;
  const text = request.method === 'GET' ? '' : await request.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  return {
    call: { method: request.method, node, path, body },
    method: request.method,
    req: { node, body },
  };
}

export function fakeGateway(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const state: FakeState = {
    options,
    now: options.now ?? 1_000,
    maps: new Map(),
    exportLeases: new Map(),
    exportSeq: 0,
    createSeq: 0,
  };
  seedStale(state);
  const fetchImpl: FetchLike = async (input, init) => {
    const parsed = await parseRequest(input, init);
    calls.push(parsed.call);
    for (const route of ROUTES) {
      if (route.method !== parsed.method) continue;
      const match = route.pattern.exec(parsed.call.path);
      if (match) return route.handle(state, { ...parsed.req, params: match.slice(1) });
    }
    return notFound();
  };
  return { fetch: fetchImpl, calls, maps: state.maps };
}

export const findCall = (calls: Call[], method: string, node: string, path: string) =>
  calls.find((call) => call.method === method && call.node === node && call.path === path);

export function entry(
  kind: 'L' | 'R',
  listenNodeId: string,
  targetNodeId: string,
  map: PortMapDto,
  leased: { mapLeased?: boolean; exportLeased?: boolean } = {}
): ForwardEntry {
  return {
    spec: {
      kind,
      bindHost: map.listenHost,
      port: map.listenPort,
      host: map.targetHost,
      hostPort: map.targetPort,
    },
    listenNodeId,
    targetNodeId,
    nodeName: 'lab',
    map,
    ...leased,
  };
}
