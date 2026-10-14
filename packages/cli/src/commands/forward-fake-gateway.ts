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

export function fakeGateway(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const maps = new Map<string, PortMapDto[]>();
  const exportLeases = new Map<string, number | undefined>();
  const now = options.now ?? 1_000;
  let exportSeq = 0;
  let createSeq = 0;
  const leases = (node: string) => !(options.legacyNodes ?? []).includes(node);
  const leaseOf = (node: string, body: Record<string, unknown> | null) =>
    leases(node) && typeof body?.leaseMs === 'number'
      ? { leaseExpiresAt: now + (body.leaseMs as number) }
      : {};
  for (const row of options.stale ?? []) {
    const list = maps.get(row.node) ?? [];
    list.push({ ...mapDto({ mapId: 'stale1', ...row.map }), ...row.map } as PortMapDto);
    maps.set(row.node, list);
  }
  const fetchImpl: FetchLike = async (input, init) => {
    const request = new Request(input, init as RequestInit);
    const url = new URL(request.url);
    const match = /^\/n\/([0-9a-f]{32})(\/.*)$/.exec(url.pathname);
    const node = match ? match[1] : 'self';
    const path = match ? match[2] : url.pathname;
    const text = request.method === 'GET' ? '' : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    calls.push({ method: request.method, node, path, body });
    const list = maps.get(node) ?? [];
    if (path === '/api/mesh/nodes') {
      return jsonResponse({
        nodes: [
          { id: NODE_A, name: 'office', publicKey: 'x', online: true, loggedIn: true },
          { id: NODE_B, name: 'lab', publicKey: 'y', online: true, loggedIn: true },
        ],
      });
    }
    if (path === '/api/auth/mode') return jsonResponse({ mode: 'mesh', nodeId: NODE_A });
    if (path === '/api/portmap/exports' && request.method === 'POST') {
      exportSeq += 1;
      const lease = leaseOf(node, body);
      exportLeases.set(`m${exportSeq}`, (lease as { leaseExpiresAt?: number }).leaseExpiresAt);
      const { leaseMs: _ignored, ...rest } = body ?? {};
      return jsonResponse({
        export: { mapId: `m${exportSeq}`, ...rest, enabled: true, createdAt: 1, ...lease },
      });
    }
    const exportItem = /^\/api\/portmap\/exports\/([^/]+)$/.exec(path);
    if (exportItem && request.method === 'DELETE') return new Response(null, { status: 204 });
    if (exportItem && request.method === 'PATCH') {
      if (!leases(node) || !exportLeases.has(exportItem[1])) {
        return jsonResponse({ error: 'not_found' }, 404);
      }
      return jsonResponse({ export: { mapId: exportItem[1], ...leaseOf(node, body) } });
    }
    if (path === '/api/portmap' && request.method === 'POST' && body) {
      createSeq += 1;
      const clash = list.some(
        (row) => row.listenHost === body.listenHost && row.listenPort === body.listenPort
      );
      if (clash || options.failMapCreate === createSeq) {
        return jsonResponse({ error: { code: 'port_in_use', message: 'occupied' } }, 409);
      }
      const dto = { ...mapDto(body), ...leaseOf(node, body) };
      maps.set(node, [...list, dto]);
      return jsonResponse({ map: dto });
    }
    if (path === '/api/portmap' && request.method === 'GET') return jsonResponse({ maps: list });
    const item = /^\/api\/portmap\/([^/]+)$/.exec(path);
    if (item && request.method === 'DELETE') {
      maps.set(
        node,
        list.filter((row) => row.id !== item[1])
      );
      return jsonResponse({ ok: true, exportRemoved: true });
    }
    if (item && request.method === 'PATCH') {
      const found = list.find((row) => row.id === item[1]);
      if (!found) return jsonResponse({ error: 'not_found' }, 404);
      Object.assign(found, leaseOf(node, body));
      return jsonResponse({ map: found });
    }
    return jsonResponse({ error: 'not_found' }, 404);
  };
  return { fetch: fetchImpl, calls, maps };
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
