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

export async function listMeshNodesFull(ctx: CliContext): Promise<MeshNode[]> {
  const response = await ctx.http.fetch(SELF_NODE_ID, '/api/mesh/nodes');
  if (response.status === 404) return [];
  await ctx.http.assertOk(SELF_NODE_ID, response, '/api/mesh/nodes');
  const payload = (await response.json()) as { nodes?: MeshNode[] };
  return payload.nodes ?? [];
}

export async function findMeshNode(ctx: CliContext, ref: string): Promise<MeshNode> {
  const resolved = await ctx.resolver.resolveNode(ref);
  if (resolved.row) return resolved.row;
  const nodes = await listMeshNodesFull(ctx);
  const row = nodes.find((node) => node.id === resolved.id);
  if (row) return row;
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
