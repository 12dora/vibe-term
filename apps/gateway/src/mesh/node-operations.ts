import type { MeshNodeOperation, MeshNodeOperationKind } from '@tmex/shared';
import { eq } from 'drizzle-orm';
import { nodeSessionCookieName, parseCookies } from '../auth/cookies';
import type { UserStore } from '../auth/user-store';
import { getDb } from '../db/client';
import { getGatewayKv, setGatewayKv } from '../db/kv';
import { gatewayKv } from '../db/schema';
import { MESH_VIA_SELF } from './mesh-deps';
import { jsonBody, jsonError } from './session-middleware';

export const NODE_OPERATION_TTL_MS = 30 * 60 * 1000;
export const NODE_OPERATION_KEY_PREFIX = 'mesh.node-op.';

export type AuthorizedUninstallForward = {
  forwardAuthorizedHttp: (
    req: Request,
    input: { nodeId: string; method: string; path: string; query?: string; body?: unknown }
  ) => Promise<Response>;
};

function kvKey(nodeId: string): string {
  return `${NODE_OPERATION_KEY_PREFIX}${nodeId}`;
}

function parseOperation(raw: string): MeshNodeOperation | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value.kind !== 'uninstall' && value.kind !== 'role-switch') return null;
    if (typeof value.phase !== 'string') return null;
    if (typeof value.startedAt !== 'number' || typeof value.updatedAt !== 'number') return null;
    if (value.error !== null && typeof value.error !== 'string') return null;
    return {
      kind: value.kind,
      phase: value.phase,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt,
      error: value.error,
    };
  } catch {
    return null;
  }
}

function listNodeOperationKeys(): string[] {
  try {
    return getDb()
      .select({ key: gatewayKv.key })
      .from(gatewayKv)
      .all()
      .map((row) => row.key)
      .filter((key) => key.startsWith(NODE_OPERATION_KEY_PREFIX));
  } catch {
    return [];
  }
}

export function writeNodeOperation(nodeId: string, op: MeshNodeOperation): void {
  setGatewayKv(kvKey(nodeId), JSON.stringify(op));
}

export function clearNodeOperation(nodeId: string): void {
  try {
    getDb()
      .delete(gatewayKv)
      .where(eq(gatewayKv.key, kvKey(nodeId)))
      .run();
  } catch {
    // gateway_kv may be absent in tests that never migrated the process db
  }
}

export function readNodeOperation(nodeId: string, now = Date.now()): MeshNodeOperation | null {
  let raw: string | null = null;
  try {
    raw = getGatewayKv(kvKey(nodeId));
  } catch {
    return null;
  }
  if (!raw) return null;
  const parsed = parseOperation(raw);
  if (!parsed) {
    clearNodeOperation(nodeId);
    return null;
  }
  if (now - parsed.updatedAt > NODE_OPERATION_TTL_MS) {
    clearNodeOperation(nodeId);
    return null;
  }
  return parsed;
}

export function updateNodeOperation(
  nodeId: string,
  patch: Partial<Pick<MeshNodeOperation, 'phase' | 'error'>>,
  now = Date.now()
): MeshNodeOperation | null {
  const current = readNodeOperation(nodeId, now);
  if (!current) return null;
  const next: MeshNodeOperation = { ...current, ...patch, updatedAt: now };
  writeNodeOperation(nodeId, next);
  return next;
}

export function startNodeOperation(
  nodeId: string,
  kind: MeshNodeOperationKind,
  now = Date.now()
): MeshNodeOperation {
  const op: MeshNodeOperation = {
    kind,
    phase: 'requested',
    startedAt: now,
    updatedAt: now,
    error: null,
  };
  writeNodeOperation(nodeId, op);
  return op;
}

export function sweepStaleNodeOperations(listedIds: ReadonlySet<string>, now = Date.now()): void {
  for (const key of listNodeOperationKeys()) {
    const nodeId = key.slice(NODE_OPERATION_KEY_PREFIX.length);
    if (!listedIds.has(nodeId)) {
      clearNodeOperation(nodeId);
      continue;
    }
    readNodeOperation(nodeId, now);
  }
}

export function resetNodeOperationsForTests(): void {
  for (const key of listNodeOperationKeys()) {
    clearNodeOperation(key.slice(NODE_OPERATION_KEY_PREFIX.length));
  }
}

function isLocalNode(localNodeId: string, nodeId: string): boolean {
  return nodeId === localNodeId || nodeId === MESH_VIA_SELF;
}

function isEnrolledNode(localNodeId: string, userStore: UserStore, nodeId: string): boolean {
  if (isLocalNode(localNodeId, nodeId)) return true;
  const cert = userStore.listCerts().find((row) => row.nodeId === nodeId);
  return cert != null && cert.revokedLogSeq == null;
}

function readNodeSession(req: Request, nodeId: string): string | null {
  return parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null;
}

function failOperation(nodeId: string, error: string, now = Date.now()): void {
  updateNodeOperation(nodeId, { phase: 'failed', error }, now);
}

export async function handleMeshNodeUninstall(opts: {
  req: Request;
  nodeId: string;
  localNodeId: string;
  userStore: UserStore;
  now?: () => number;
  forward: AuthorizedUninstallForward;
}): Promise<Response> {
  const { req, nodeId, localNodeId, userStore, forward } = opts;
  const now = opts.now?.() ?? Date.now();
  if (isLocalNode(localNodeId, nodeId)) {
    return jsonError('UNINSTALL_SELF_BLOCKED', 409, { nodeId: localNodeId });
  }
  if (!isEnrolledNode(localNodeId, userStore, nodeId)) {
    return jsonError('NOT_FOUND', 404, { nodeId });
  }
  if (!readNodeSession(req, nodeId)) {
    return jsonError('NODE_LOGIN_REQUIRED', 401, { nodeId });
  }

  startNodeOperation(nodeId, 'uninstall', now);

  let upstream: Response;
  try {
    upstream = await forward.forwardAuthorizedHttp(req, {
      nodeId,
      method: 'POST',
      path: '/api/system/uninstall',
      body: { mode: 'full' },
    });
  } catch {
    failOperation(nodeId, 'NODE_UNREACHABLE', now);
    return jsonError('NODE_UNREACHABLE', 503, { nodeId });
  }

  if (upstream.status === 202) {
    updateNodeOperation(nodeId, { phase: 'uninstalling' }, now);
    return upstream;
  }

  if (upstream.status === 404 || upstream.status === 405) {
    void upstream.body?.cancel().catch(() => {});
    failOperation(nodeId, 'UNINSTALL_UNSUPPORTED', now);
    return jsonError('UNINSTALL_UNSUPPORTED', 501, { nodeId });
  }

  if (upstream.status === 409) {
    const parsed = await readJsonObject(upstream);
    const code =
      parsed?.code === 'UPGRADE_IN_PROGRESS' || parsed?.code === 'UNINSTALL_NOT_ALLOWED'
        ? parsed.code
        : 'UNINSTALL_NOT_ALLOWED';
    failOperation(nodeId, code, now);
    const extra: Record<string, unknown> = { nodeId };
    if (typeof parsed?.reason === 'string') extra.reason = parsed.reason;
    return jsonError(code, 409, extra);
  }

  if (upstream.status === 503) {
    failOperation(nodeId, 'NODE_UNREACHABLE', now);
    return upstream;
  }

  failOperation(nodeId, `HTTP_${upstream.status}`, now);
  return upstream;
}

export function handleNodeOperationGet(nodeId: string, now = Date.now()): Response {
  const op = readNodeOperation(nodeId, now);
  if (!op) return jsonError('NOT_FOUND', 404, { nodeId });
  return jsonBody(op);
}

export function handleNodeOperationDelete(nodeId: string): Response {
  clearNodeOperation(nodeId);
  return jsonBody({ ok: true });
}

async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}
