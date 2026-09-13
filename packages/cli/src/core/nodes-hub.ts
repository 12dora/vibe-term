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
    lastSeenAt: row.last_seen_at ?? null,
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
 * ADDRESS：hub publicUrl → 直连 peerAddress → 广告 endpoint（偏公网）
 * → viaRelay / relayPresence。pending / 推不出为 `-`。
 */
export function nodeAddressOf(
  node: MeshNode & { status?: string },
  hubUrls?: ReadonlyMap<string, string>
): string {
  if (node.status === 'pending') return '-';
  if (node.isHub) {
    const hub = displayHost(hubUrls?.get(node.id));
    if (hub) return hub;
  }
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
  if (node.online) return 'yes';
  const rel = formatRelativeLastSeen(node.lastSeenAt, now);
  return rel ? `no · ${rel}` : 'no';
}

export async function hubUrlByNodeId(ctx: CliContext): Promise<Map<string, string>> {
  const payload = await fetchHubs(ctx).catch(() => null);
  const map = new Map<string, string>();
  for (const hub of payload?.hubs ?? []) {
    if (hub.nodeId && hub.publicUrl) map.set(hub.nodeId, hub.publicUrl);
  }
  return map;
}
