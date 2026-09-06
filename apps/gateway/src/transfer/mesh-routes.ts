// 目标节点 B 的 peer-only 接口。`/api/mesh-internal/*` 的 peer 标记只证明「对端是本用户的
// 某台受信任节点」，真正的授权来自 grant（浏览器用自己的 B 会话签发、绑死源节点与目标目录）。

import type { TransferErrorCode } from '@tmex/shared';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { readMeshPeerMarker } from '../mesh/peer-request-marker';
import { MESH_TRANSFER_PREFIX } from './channel';
import { SESSION_IDLE_MS } from './limits';
import {
  type ReceiverFailure,
  type TransferSession,
  closeSession,
  getSession,
  openSession,
} from './receiver';
import { commitFile, fileStatus, makeDirectory, writeFileRange } from './receiver-files';

const STATUS_BY_CODE: Partial<Record<TransferErrorCode, number>> = {
  grant_invalid: 403,
  grant_expired: 403,
  peer_mismatch: 403,
  quota_file_size: 413,
  too_large: 413,
  dest_exists: 409,
  dest_conflict: 409,
  limit_exceeded: 429,
  offset_mismatch: 409,
  incomplete: 409,
  not_found: 404,
  root_not_found: 404,
  device_not_found: 404,
  root_disabled: 403,
  outside_roots: 403,
  permission_denied: 403,
  invalid: 400,
  cancelled: 409,
};

function errorResponse(failure: ReceiverFailure): Response {
  const status = STATUS_BY_CODE[failure.code] ?? 500;
  return json({ error: failure.code, code: failure.code, detail: failure.detail }, status);
}

function peerOf(req: Request): string | null {
  return readMeshPeerMarker(req);
}

function requireSession(req: Request, sessionId: string): TransferSession | Response {
  const peer = peerOf(req);
  if (!peer) return json({ error: 'peer_mismatch', code: 'peer_mismatch' }, 403);
  const session = getSession(sessionId, peer);
  if (!session) return json({ error: 'not_found', code: 'not_found' }, 404);
  return session;
}

async function handleOpen(req: Request): Promise<Response> {
  const peer = peerOf(req);
  if (!peer) return json({ error: 'peer_mismatch', code: 'peer_mismatch' }, 403);
  const body = await readJsonObjectBody(req);
  const grantId = typeof body?.grantId === 'string' ? body.grantId : '';
  const token = typeof body?.token === 'string' ? body.token : '';
  const onConflict = body?.onConflict === 'overwrite' ? 'overwrite' : 'skip';
  if (!grantId || !token) return json({ error: 'invalid', code: 'invalid' }, 400);
  const opened = openSession({ grantId, token, peerNodeId: peer, onConflict });
  if (!opened.ok) return errorResponse(opened);
  const { ok: _ok, ...payload } = opened;
  return json(payload);
}

function readFileRef(
  body: Record<string, unknown> | null
): { relPath: string; size: number } | null {
  const relPath = typeof body?.relPath === 'string' ? body.relPath : '';
  const size = typeof body?.size === 'number' && Number.isSafeInteger(body.size) ? body.size : -1;
  if (!relPath || size < 0) return null;
  return { relPath, size };
}

async function handleStatus(req: Request, sessionId: string): Promise<Response> {
  const session = requireSession(req, sessionId);
  if (session instanceof Response) return session;
  const ref = readFileRef(await readJsonObjectBody(req));
  if (!ref) return json({ error: 'invalid', code: 'invalid' }, 400);
  const state = await fileStatus(session, ref.relPath, ref.size);
  if (!state.ok) return errorResponse(state);
  return json({ receivedBytes: state.receivedBytes, ranges: state.ranges });
}

function parseInt0(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

async function handleWrite(req: Request, sessionId: string): Promise<Response> {
  const session = requireSession(req, sessionId);
  if (session instanceof Response) return session;
  const url = new URL(req.url);
  const relPath = url.searchParams.get('rel') ?? '';
  const size = parseInt0(url.searchParams.get('size'));
  const offset = parseInt0(url.searchParams.get('offset'));
  const length = parseInt0(url.searchParams.get('length'));
  if (!relPath || size === null || offset === null) {
    return json({ error: 'invalid', code: 'invalid' }, 400);
  }
  const body = req.body ?? emptyStream();
  const written = await writeFileRange(
    session,
    { relPath, size, offset, length: length ?? undefined },
    body
  );
  if (!written.ok) return errorResponse(written);
  return json({ received: written.received, complete: written.complete });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function handleCommit(req: Request, sessionId: string): Promise<Response> {
  const session = requireSession(req, sessionId);
  if (session instanceof Response) return session;
  const ref = readFileRef(await readJsonObjectBody(req));
  if (!ref) return json({ error: 'invalid', code: 'invalid' }, 400);
  const done = await commitFile(session, ref.relPath, ref.size);
  if (!done.ok) return errorResponse(done);
  return json({ ok: true, skipped: done.skipped });
}

async function handleClose(req: Request, sessionId: string): Promise<Response> {
  const session = requireSession(req, sessionId);
  if (session instanceof Response) return session;
  // 等在跑的操作收尾再回：DELETE 返回时目标侧确实已经清干净了
  await closeSession(session.id);
  return json({ ok: true });
}

async function handleMkdir(req: Request, sessionId: string): Promise<Response> {
  const session = requireSession(req, sessionId);
  if (session instanceof Response) return session;
  const body = await readJsonObjectBody(req);
  const relPath = typeof body?.relPath === 'string' ? body.relPath : '';
  if (!relPath) return json({ error: 'invalid', code: 'invalid' }, 400);
  const made = await makeDirectory(session, relPath);
  if (!made.ok) return errorResponse(made);
  return json({ ok: true });
}

/** 续期：源侧在暂存大文件时用它把目标会话按住，别让空闲 GC 收掉。 */
function handleKeepAlive(req: Request, sessionId: string): Response {
  const session = requireSession(req, sessionId);
  if (session instanceof Response) return session;
  return json({ ok: true, expiresAt: session.lastUsedAt + SESSION_IDLE_MS });
}

export function createMeshInternalTransferRoutes(): ApiRoute[] {
  return [
    route({
      method: 'POST',
      path: `${MESH_TRANSFER_PREFIX}/sessions`,
      handler: (req) => handleOpen(req),
    }),
    route({
      method: 'POST',
      path: `${MESH_TRANSFER_PREFIX}/sessions/:sid/status`,
      handler: (req, params) => handleStatus(req, params.sid),
    }),
    route({
      method: 'PUT',
      path: `${MESH_TRANSFER_PREFIX}/sessions/:sid/files`,
      handler: (req, params) => handleWrite(req, params.sid),
    }),
    route({
      method: 'POST',
      path: `${MESH_TRANSFER_PREFIX}/sessions/:sid/commit`,
      handler: (req, params) => handleCommit(req, params.sid),
    }),
    route({
      method: 'POST',
      path: `${MESH_TRANSFER_PREFIX}/sessions/:sid/dirs`,
      handler: (req, params) => handleMkdir(req, params.sid),
    }),
    route({
      method: 'POST',
      path: `${MESH_TRANSFER_PREFIX}/sessions/:sid/keepalive`,
      handler: (req, params) => handleKeepAlive(req, params.sid),
    }),
    route({
      method: 'DELETE',
      path: `${MESH_TRANSFER_PREFIX}/sessions/:sid`,
      handler: (req, params) => handleClose(req, params.sid),
    }),
  ];
}
