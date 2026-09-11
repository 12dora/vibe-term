// 定位 writer hub、拼 join 命令、读 mesh / hub 节点表。

import type { MeshHubsResponse, MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { fetchAuthMode } from './auth';
import type { CliContext } from './context';
import { CliError, NotFoundError, UsageError } from './errors';

export interface HubNodeRow {
  id: string;
  name: string;
  status: string;
  online: boolean;
  version: string | null;
  last_seen_at: number | null;
  direct_capable: boolean;
  admission_status?: 'pending' | 'admitted' | 'revoked';
  enrollment_id?: string;
  authorization?: string;
  authorization_sig?: string;
  certificate?: string;
  cert_sig?: string;
}

export interface MeshNodesList {
  nodes: MeshNode[];
  pendingMemberIds: string[];
}

export async function listMeshNodesDetailed(ctx: CliContext): Promise<MeshNodesList> {
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/mesh/nodes');
  if (response.status === 404) return { nodes: [], pendingMemberIds: [] };
  await ctx.http.assertOk(SELF_NODE_ID, response, '/api/mesh/nodes');
  const payload = (await response.json()) as { nodes?: MeshNode[]; pendingMemberIds?: unknown };
  const pending = Array.isArray(payload.pendingMemberIds)
    ? payload.pendingMemberIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { nodes: payload.nodes ?? [], pendingMemberIds: pending };
}

export async function listMeshNodesFull(ctx: CliContext): Promise<MeshNode[]> {
  return (await listMeshNodesDetailed(ctx)).nodes;
}

export type ListedNode = MeshNode & { status: 'pending' | 'admitted' };

export function hubRowAsPending(row: HubNodeRow): ListedNode {
  return {
    id: row.id,
    name: row.name?.trim() || row.id.slice(0, 8),
    publicKey: '',
    online: row.online,
    reach: null,
    version: row.version,
    direct_capable: row.direct_capable,
    loggedIn: false,
    status: 'pending',
  };
}

export async function listListedNodes(ctx: CliContext): Promise<ListedNode[]> {
  const mesh = await listMeshNodesFull(ctx);
  const hubRows = await listHubNodes(ctx).catch(() => [] as HubNodeRow[]);
  const meshIds = new Set(mesh.map((node) => node.id));
  const admitted: ListedNode[] = mesh.map((node) => ({ ...node, status: 'admitted' as const }));
  const pending: ListedNode[] = [];
  const seen = new Set<string>();
  for (const row of hubRows) {
    if (row.admission_status !== 'pending' || meshIds.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    pending.push(hubRowAsPending(row));
  }
  pending.sort((a, b) => a.name.localeCompare(b.name));
  return [...admitted, ...pending];
}

function matchHubRow(rows: HubNodeRow[], ref: string): HubNodeRow | null {
  const trimmed = ref.trim();
  if (/^[0-9a-f]{32}$/.test(trimmed)) {
    return rows.find((row) => row.id === trimmed) ?? null;
  }
  const matches = rows.filter((row) => row.name === trimmed);
  if (matches.length > 1) {
    throw new UsageError(
      `node name "${trimmed}" is ambiguous: ${matches.map((row) => row.id).join(', ')}`,
      'use the node id instead'
    );
  }
  return matches[0] ?? null;
}

export async function findHubNode(ctx: CliContext, ref: string): Promise<HubNodeRow | null> {
  const rows = await listHubNodes(ctx).catch(() => [] as HubNodeRow[]);
  return matchHubRow(rows, ref);
}

export async function findMeshNode(ctx: CliContext, ref: string): Promise<MeshNode> {
  const resolved = await ctx.resolver.resolveNode(ref);
  if (resolved.row) return resolved.row;
  const nodes = await listMeshNodesFull(ctx);
  const row = nodes.find((node) => node.id === resolved.id);
  if (row) return row;
  throw new NotFoundError(`unknown node: ${ref}`, 'run: vibeterm nodes ls');
}

export interface AdminNode {
  id: string;
  name: string;
  mesh: MeshNode | null;
  hub: HubNodeRow | null;
}

export async function findAdminNode(ctx: CliContext, ref: string): Promise<AdminNode> {
  const hub = await findHubNode(ctx, ref);
  const mesh = await findMeshNode(ctx, ref).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (hub && mesh && hub.id !== mesh.id) {
    throw new UsageError(
      `node name "${ref.trim()}" is ambiguous: ${hub.id}, ${mesh.id}`,
      'use the 32-hex node id instead'
    );
  }
  if (mesh) return { id: mesh.id, name: mesh.name, mesh, hub };
  if (hub) return { id: hub.id, name: hub.name, mesh: null, hub };
  throw new NotFoundError(`unknown node: ${ref}`, 'run: vibeterm nodes ls');
}

export async function resolveHubNodeId(ctx: CliContext): Promise<string> {
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (mode?.hubNodeId) return mode.hubNodeId;
  const nodes = await listMeshNodesFull(ctx);
  const hubs = nodes.filter((node) => node.isHub);
  if (hubs.length === 1) return hubs[0].id;
  const selfHub = nodes.find((node) => node.isHub && node.id === mode?.nodeId);
  if (selfHub) return selfHub.id;
  if (hubs.length > 1) {
    throw new UsageError(
      `multiple hubs: ${hubs.map((node) => node.id).join(', ')}`,
      'point --entry at the writer hub, or use vibeterm nodes hubs'
    );
  }
  throw new CliError('no hub is attached to this entry', 1, 'run: vibeterm nodes hubs');
}

export async function listHubNodes(ctx: CliContext): Promise<HubNodeRow[]> {
  const hubId = await resolveHubNodeId(ctx);
  const payload = await ctx.http.json<{ nodes?: HubNodeRow[] }>(hubId, 'GET', '/api/hub/nodes');
  return payload.nodes ?? [];
}

export async function fetchHubs(ctx: CliContext): Promise<MeshHubsResponse> {
  return ctx.http.json<MeshHubsResponse>(SELF_NODE_ID, 'GET', '/api/mesh/hubs');
}

export function isTrustedHubUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function joinCommand(hubPublicUrl: string, token: string, name?: string | null): string {
  if (!isTrustedHubUrl(hubPublicUrl)) {
    throw new CliError('hub public url is missing or not https; cannot print a join command');
  }
  const suffix = name?.trim() ? ` --name ${shellQuote(name.trim())}` : '';
  return `vibeterm hub join ${shellQuote(hubPublicUrl)} --token ${shellQuote(token)}${suffix}`;
}

export function passwordJoinCommand(hubPublicUrl: string): string {
  if (!isTrustedHubUrl(hubPublicUrl)) {
    throw new CliError('hub public url is missing or not https; cannot print a join command');
  }
  return `vibeterm hub join ${shellQuote(hubPublicUrl)} --password`;
}

export function roleOf(node: MeshNode): string {
  if (node.isHub) return node.hubMode ? `hub/${node.hubMode}` : 'hub';
  return 'node';
}

export function reachOf(node: MeshNode): string {
  const transport = node.transport ?? '';
  const reach = node.reach ?? '';
  if (reach && transport) return `${reach}/${transport}`;
  return reach || transport || '-';
}
