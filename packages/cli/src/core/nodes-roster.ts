// 读 mesh 名册、拼 relay join 命令。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import type { MeshNode } from '@vibeterm/shared';
import type { CliContext } from './context';
import { CliError, NotFoundError } from './errors';

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

function pendingStub(id: string): ListedNode {
  return {
    id,
    name: id.slice(0, 8),
    publicKey: '',
    online: false,
    reach: null,
    version: null,
    direct_capable: false,
    loggedIn: false,
    lastSeenAt: null,
    status: 'pending',
  };
}

export async function listListedNodes(ctx: CliContext): Promise<ListedNode[]> {
  const { nodes, pendingMemberIds } = await listMeshNodesDetailed(ctx);
  const meshIds = new Set(nodes.map((node) => node.id));
  const admitted: ListedNode[] = nodes.map((node) => ({ ...node, status: 'admitted' as const }));
  const pending: ListedNode[] = [];
  const seen = new Set<string>();
  for (const id of pendingMemberIds) {
    if (meshIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    pending.push(pendingStub(id));
  }
  pending.sort((a, b) => a.name.localeCompare(b.name));
  return [...admitted, ...pending];
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
}

export async function findAdminNode(ctx: CliContext, ref: string): Promise<AdminNode> {
  const mesh = await findMeshNode(ctx, ref).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (mesh) return { id: mesh.id, name: mesh.name, mesh };
  throw new NotFoundError(`unknown node: ${ref}`, 'run: vibeterm nodes ls');
}

export function isTrustedPublicUrl(value: string | null | undefined): boolean {
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

export function joinCommand(publicUrl: string, token: string, name?: string | null): string {
  if (!isTrustedPublicUrl(publicUrl)) {
    throw new CliError('public url is missing or not https; cannot print a join command');
  }
  const suffix = name?.trim() ? ` --name ${shellQuote(name.trim())}` : '';
  return `vibeterm relay join ${shellQuote(publicUrl)} --token ${shellQuote(token)}${suffix}`;
}

export function passwordJoinCommand(publicUrl: string): string {
  if (!isTrustedPublicUrl(publicUrl)) {
    throw new CliError('public url is missing or not https; cannot print a join command');
  }
  return `vibeterm relay join ${shellQuote(publicUrl)} --password`;
}

export function roleOf(_node: MeshNode): string {
  return 'node';
}

export function reachOf(node: MeshNode): string {
  if (node.online === false) return '-';
  const transport = node.transport ?? '';
  const reach = node.reach ?? '';
  if (!reach && !transport) return '-';
  if (reach === 'relay' && (!transport || transport === 'relay')) return 'relay';
  if (transport === 'relay' && (!reach || reach === 'relay')) return 'relay';
  if (reach && transport) return `${reach}/${transport}`;
  return reach || transport;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 剥 scheme / path，保留 host[:port]。 */
export function displayHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = SCHEME_RE.test(value) ? new URL(value) : new URL(`https://${value}`);
    if (!url.hostname) return value;
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return value;
  }
}

function advertisedHost(endpoints: readonly string[] | null | undefined): string | null {
  if (!endpoints?.length) return null;
  let fallback: string | null = null;
  for (const item of endpoints) {
    const host = displayHost(item);
    if (!host) continue;
    if (!fallback) fallback = host;
    if (!isLanHost(host)) return host;
  }
  return fallback;
}

function hostOnly(hostPort: string): string {
  const value = hostPort.replace(/^\[|\]$/g, '');
  const colon = value.lastIndexOf(':');
  if (colon > 0 && value.indexOf(':') === colon) return value.slice(0, colon).toLowerCase();
  return value.toLowerCase();
}

function isLanHost(hostPort: string): boolean {
  const host = hostOnly(hostPort);
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
    return true;
  }
  const m = /^172\.(\d+)\./.exec(host);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (!host.includes(':')) return false;
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

/**
 * ADDRESS：直连 peerAddress → 广告 endpoint（偏公网）
 * → viaRelay / relayPresence。pending / 推不出为 `-`。
 */
export function nodeAddressOf(node: MeshNode & { status?: string }): string {
  if (node.status === 'pending') return '-';
  const transport = node.transport ?? null;
  if (transport === 'ws-secure' || transport === 'dc') {
    const live = displayHost(node.peerAddress);
    if (live) return live;
  }
  const advertised = advertisedHost(node.endpoints);
  if (advertised) return advertised;
  if (transport === 'relay') {
    const via = displayHost(node.viaRelay);
    if (via) return via;
  }
  return displayHost(node.relayPresence?.[0]) ?? '-';
}

export function formatRelativeLastSeen(
  at: number | null | undefined,
  now = Date.now()
): string | null {
  if (at == null || !Number.isFinite(at) || at <= 0) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

export function listedOnline(node: MeshNode, now = Date.now()): string {
  if (node.online) return node.loggedIn ? 'yes · signed-in' : 'yes · signed-out';
  const rel = formatRelativeLastSeen(node.lastSeenAt, now);
  return rel ? `no · ${rel}` : 'no';
}
