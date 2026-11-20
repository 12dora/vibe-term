// mesh 名册：先打 entry 的 GET /api/mesh/nodes；入口没有任何凭据时改问 jar 里有活会话的其它节点。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { NetworkError } from './errors';
import { type HttpClient, isSessionAuthFailure } from './http';
import { codeFromBody, isPopErrorCode } from './session-pop';
import { isLiveNodeSession } from './session-store';

export const MESH_NODES_PATH = '/api/mesh/nodes';
const FALLBACK_LIMIT = 3;

export interface MeshRoster {
  nodes: MeshNode[];
  pendingMemberIds: string[];
  /** `'self'` 表示入口自己答的；否则是应答节点的 mesh id。 */
  source: string;
}

export type MeshNodesResult =
  | { ok: true; nodes: MeshNode[]; source: string }
  | { ok: false; unauthorized: true };

type RosterRead =
  | { kind: 'ok'; roster: Omit<MeshRoster, 'source'> }
  | { kind: 'empty' }
  | { kind: 'auth'; status: number; body: string }
  | { kind: 'pop'; status: number; body: string }
  | { kind: 'other'; status: number; body: string }
  | { kind: 'network'; error: unknown };

function emptyRoster(): MeshRoster {
  return { nodes: [], pendingMemberIds: [], source: SELF_NODE_ID };
}

function withSource(roster: Omit<MeshRoster, 'source'>, source: string): MeshRoster {
  return { ...roster, source };
}

function parseRoster(payload: unknown): Omit<MeshRoster, 'source'> {
  const body = (payload ?? {}) as { nodes?: MeshNode[]; pendingMemberIds?: unknown };
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const pending = Array.isArray(body.pendingMemberIds)
    ? body.pendingMemberIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { nodes, pendingMemberIds: pending };
}

function liveFallbackIds(http: HttpClient): string[] {
  const ids: string[] = [];
  for (const session of http.jar.list()) {
    if (session.nodeId === SELF_NODE_ID) continue;
    if (!isLiveNodeSession(session)) continue;
    ids.push(session.nodeId);
    if (ids.length >= FALLBACK_LIMIT) break;
  }
  return ids;
}

function selfRosterError(http: HttpClient, status: number, body: string): never {
  throw http.statusError(SELF_NODE_ID, MESH_NODES_PATH, status, body);
}

async function readMeshRoster(http: HttpClient, nodeId: string): Promise<RosterRead> {
  let response: Response;
  try {
    response = await http.fetch(nodeId, MESH_NODES_PATH);
  } catch (error) {
    return { kind: 'network', error };
  }
  if (response.status === 404) return { kind: 'empty' };
  if (response.ok) return { kind: 'ok', roster: parseRoster(await response.json()) };
  const body = await response.text();
  if (isPopErrorCode(codeFromBody(body))) return { kind: 'pop', status: response.status, body };
  if (isSessionAuthFailure(response.status, body)) {
    return { kind: 'auth', status: response.status, body };
  }
  return { kind: 'other', status: response.status, body };
}

async function tryFallbackRoster(http: HttpClient): Promise<MeshRoster | null> {
  for (const nodeId of liveFallbackIds(http)) {
    const result = await readMeshRoster(http, nodeId);
    if (result.kind === 'ok') return withSource(result.roster, nodeId);
  }
  return null;
}

async function fallbackOrSelfError(
  http: HttpClient,
  self: Extract<RosterRead, { kind: 'auth' }>
): Promise<MeshRoster> {
  if (http.hasEntryCredential()) return selfRosterError(http, self.status, self.body);
  const fallback = await tryFallbackRoster(http);
  if (fallback) return fallback;
  return selfRosterError(http, self.status, self.body);
}

/**
 * 名册：self 2xx / 404 与今天一致；self 会话鉴权失败且入口没有任何凭据时，
 * 按 jar 顺序最多再问 3 个有活会话的节点。全失败抛 self 的入口无会话错误。PoP 直接抛。
 */
export async function fetchMeshRoster(http: HttpClient): Promise<MeshRoster> {
  const self = await readMeshRoster(http, SELF_NODE_ID);
  if (self.kind === 'ok') return withSource(self.roster, SELF_NODE_ID);
  if (self.kind === 'empty') return emptyRoster();
  if (self.kind === 'network') throw self.error;
  if (self.kind === 'pop' || self.kind === 'other') {
    return selfRosterError(http, self.status, self.body);
  }
  return fallbackOrSelfError(http, self);
}

/** whoami / login-code：401 不抛，标 unauthorized；有 fallback 名册则当成功。 */
export async function fetchMeshNodes(http: HttpClient): Promise<MeshNodesResult> {
  const self = await readMeshRoster(http, SELF_NODE_ID);
  if (self.kind === 'ok') return { ok: true, nodes: self.roster.nodes, source: SELF_NODE_ID };
  if (self.kind === 'empty') return { ok: true, nodes: [], source: SELF_NODE_ID };
  if (self.kind === 'network') throw self.error;
  if (self.kind === 'pop') return selfRosterError(http, self.status, self.body);
  if (self.kind === 'other') {
    throw new NetworkError(`GET ${MESH_NODES_PATH} → HTTP ${self.status}`);
  }
  if (http.hasEntryCredential()) return { ok: false, unauthorized: true };
  const fallback = await tryFallbackRoster(http);
  if (fallback) return { ok: true, nodes: fallback.nodes, source: fallback.source };
  return { ok: false, unauthorized: true };
}

/** standalone 入口没有这个路由，视为空表；self 未授权且 fallback 也没有则空表。 */
export async function listMeshNodes(http: HttpClient): Promise<MeshNode[]> {
  const result = await fetchMeshNodes(http);
  return result.ok ? result.nodes : [];
}
