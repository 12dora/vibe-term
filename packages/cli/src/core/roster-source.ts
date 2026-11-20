// mesh 名册：先打 entry 的 GET /api/mesh/nodes；entry 无会话时改问 jar 里有活会话的其它节点。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { NetworkError } from './errors';
import { type HttpClient, httpStatusError, isSessionAuthFailure } from './http';
import { codeFromBody, isPopErrorCode } from './session-pop';
import { isLiveNodeSession } from './session-store';

export const MESH_NODES_PATH = '/api/mesh/nodes';
const FALLBACK_LIMIT = 3;

export interface MeshRoster {
  nodes: MeshNode[];
  pendingMemberIds: string[];
}

export type MeshNodesResult = { ok: true; nodes: MeshNode[] } | { ok: false; unauthorized: true };

type RosterRead =
  | { kind: 'ok'; roster: MeshRoster }
  | { kind: 'empty' }
  | { kind: 'auth'; status: number; body: string }
  | { kind: 'pop'; status: number; body: string }
  | { kind: 'other'; status: number; body: string }
  | { kind: 'network'; error: unknown };

function emptyRoster(): MeshRoster {
  return { nodes: [], pendingMemberIds: [] };
}

function parseRoster(payload: unknown): MeshRoster {
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

function selfRosterError(status: number, body: string): never {
  throw httpStatusError(SELF_NODE_ID, MESH_NODES_PATH, status, body);
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
    if (result.kind === 'ok') return result.roster;
  }
  return null;
}

/**
 * 名册：self 2xx / 404 与今天一致；self 会话鉴权失败时按 jar 顺序最多再问 3 个有活会话的节点。
 * 全失败抛 self 的原始错误（文案与退出码不变）。PoP 不当成「没登录」，直接抛。
 */
export async function fetchMeshRoster(http: HttpClient): Promise<MeshRoster> {
  const self = await readMeshRoster(http, SELF_NODE_ID);
  if (self.kind === 'ok') return self.roster;
  if (self.kind === 'empty') return emptyRoster();
  if (self.kind === 'network') throw self.error;
  if (self.kind === 'pop' || self.kind === 'other') return selfRosterError(self.status, self.body);
  const fallback = await tryFallbackRoster(http);
  if (fallback) return fallback;
  return selfRosterError(self.status, self.body);
}

/** whoami / login-code：401 不抛，标 unauthorized；有 fallback 名册则当成功。 */
export async function fetchMeshNodes(http: HttpClient): Promise<MeshNodesResult> {
  const self = await readMeshRoster(http, SELF_NODE_ID);
  if (self.kind === 'ok') return { ok: true, nodes: self.roster.nodes };
  if (self.kind === 'empty') return { ok: true, nodes: [] };
  if (self.kind === 'network') throw self.error;
  if (self.kind === 'pop') return selfRosterError(self.status, self.body);
  if (self.kind === 'other') {
    throw new NetworkError(`GET ${MESH_NODES_PATH} → HTTP ${self.status}`);
  }
  const fallback = await tryFallbackRoster(http);
  if (fallback) return { ok: true, nodes: fallback.nodes };
  return { ok: false, unauthorized: true };
}

/** standalone 入口没有这个路由，视为空表；self 未授权且 fallback 也没有则空表。 */
export async function listMeshNodes(http: HttpClient): Promise<MeshNode[]> {
  const result = await fetchMeshNodes(http);
  return result.ok ? result.nodes : [];
}
