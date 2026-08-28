import { config } from '../config';
import {
  pullFileFromDevice,
  pushFileToDevice,
  sanitizeUploadName,
  statFile,
} from '../files/device-storage';
import {
  appendUploadChunk,
  createDownloadSession,
  createUploadSession,
  getDownloadSession,
  getUploadSession,
} from '../files/transfer-session';
import { t } from '../i18n';
import { requestDispatchContext } from '../mesh/types';
import {
  attachmentHeaders,
  codeError,
  ndjsonResponse,
  parseNonNegativeSafeInt,
  streamTempFile,
} from './file-http';
import { cleanupDownload, cleanupUpload, rememberTransferUid } from './files';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function uidFromRequest(req: Request): string {
  return requestDispatchContext.get(req)?.uid ?? '';
}

const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

async function handleUploadInit(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);
  const rootId = typeof body.rootId === 'string' ? body.rootId : '';
  const destDir = typeof body.path === 'string' ? body.path : '';
  const rawName = typeof body.name === 'string' ? body.name : '';
  const size = typeof body.size === 'number' && Number.isSafeInteger(body.size) ? body.size : -1;
  if (!rootId || !destDir || !rawName || size < 0) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const name = sanitizeUploadName(rawName);
  if (!name) return codeError('invalid');
  if (size > config.transferMaxBytes) return codeError('too_large');

  const stat = await statFile(rootId, destDir);
  if (!stat.ok) return codeError(stat.code, stat.detail);
  if (stat.data.type !== 'dir') return codeError('not_a_directory');

  const session = createUploadSession({ rootId, destDir, name, size });
  rememberTransferUid(session.id, uidFromRequest(req));
  return json({ uploadId: session.id, chunkSize: UPLOAD_CHUNK_SIZE });
}

async function handleUploadChunk(req: Request, id: string, url: URL): Promise<Response> {
  const offset = parseNonNegativeSafeInt(url.searchParams.get('offset'));
  if (offset === null) return json({ error: t('apiError.invalidRequest') }, 400);
  const bytes = new Uint8Array(await req.arrayBuffer());
  const res = appendUploadChunk(id, offset, bytes);
  if (!res.ok) {
    if (res.reason === 'not_found') return codeError('not_found');
    if (res.reason === 'too_large') return codeError('too_large');
    return json({ error: t('apiError.invalidRequest') }, 409);
  }
  return json({ received: res.received });
}

function handleUploadCommit(id: string): Response {
  const session = getUploadSession(id);
  if (!session) return codeError('not_found');
  if (session.received !== session.size) return codeError('invalid', 'incomplete upload');
  session.committing = true;

  return ndjsonResponse({
    start(emit, close) {
      pushFileToDevice(session.rootId, session.destDir, session.tmpPath, session.name, {
        signal: session.abort.signal,
        onProgress: (p) => emit({ type: 'progress', ...p }),
      })
        .then((res) => {
          if (res.ok) emit({ type: 'done', uploaded: res.data.uploaded });
          else emit({ type: 'error', code: res.code, detail: res.detail });
        })
        .catch((e) => emit({ type: 'error', code: 'unknown', detail: String(e) }))
        .finally(() => {
          close();
          cleanupUpload(id);
        });
    },
    cancel() {
      cleanupUpload(id);
    },
  });
}

function handleUploadCancel(id: string): Response {
  cleanupUpload(id);
  return json({ success: true });
}

function handleDownloadPrepare(req: Request): Response {
  let abort: AbortController | null = null;
  return ndjsonResponse({
    async start(emit, close) {
      const body = await readJsonObjectBody(req);
      const rootId = typeof body?.rootId === 'string' ? body.rootId : '';
      const path = typeof body?.path === 'string' ? body.path : '';
      if (!rootId || !path) {
        emit({ type: 'error', code: 'invalid' });
        close();
        return;
      }
      abort = new AbortController();
      const result = await pullFileFromDevice(rootId, path, {
        signal: abort.signal,
        onProgress: (p) => emit({ type: 'progress', ...p }),
      });
      if (result.ok) {
        const s = createDownloadSession({
          tmpPath: result.data.tmpPath,
          size: result.data.size,
          name: result.data.name,
          mime: result.data.mime,
          cleanup: result.data.cleanup,
        });
        rememberTransferUid(s.id, uidFromRequest(req));
        emit({ type: 'done', downloadId: s.id, size: s.size, name: s.name });
      } else {
        emit({ type: 'error', code: result.code, detail: result.detail });
      }
      close();
    },
    cancel() {
      abort?.abort();
    },
  });
}

function handleDownloadContent(id: string): Response {
  const session = getDownloadSession(id);
  if (!session) return codeError('not_found');
  const body = streamTempFile(session.tmpPath, () => cleanupDownload(id));
  if (!body) return codeError('unknown');
  return new Response(body, {
    status: 200,
    headers: attachmentHeaders(session.name, session.mime, session.size),
  });
}

function handleDownloadCancel(id: string): Response {
  cleanupDownload(id);
  return json({ success: true });
}

async function handleDownload(req: Request, url: URL): Promise<Response> {
  const rootId = url.searchParams.get('rootId');
  const path = url.searchParams.get('path');
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);

  const result = await pullFileFromDevice(rootId, path, {
    signal: req.signal,
    onProgress: () => {},
  });
  if (!result.ok) return codeError(result.code, result.detail);
  const { tmpPath, size, name, mime, cleanup } = result.data;
  const body = streamTempFile(tmpPath, cleanup);
  if (!body) return codeError('unknown');
  return new Response(body, { status: 200, headers: attachmentHeaders(name, mime, size) });
}

export const fileTransferRoutes: ApiRoute[] = [
  route({
    method: 'GET',
    path: '/api/files/download',
    handler: (req) => handleDownload(req, new URL(req.url)),
  }),
  route({
    method: 'POST',
    path: '/api/files/download/prepare',
    handler: (req) => handleDownloadPrepare(req),
  }),
  route({
    method: 'GET',
    path: '/api/files/download/:id/content',
    handler: (_req, params) => handleDownloadContent(decodeURIComponent(params.id)),
  }),
  route({
    method: 'DELETE',
    path: '/api/files/download/:id',
    handler: (_req, params) => handleDownloadCancel(decodeURIComponent(params.id)),
  }),
  route({
    method: 'POST',
    path: '/api/files/upload/init',
    handler: (req) => handleUploadInit(req),
  }),
  route({
    method: 'POST',
    path: '/api/files/upload/:id/commit',
    handler: (_req, params) => handleUploadCommit(decodeURIComponent(params.id)),
  }),
  route({
    method: 'PUT',
    path: '/api/files/upload/:id',
    handler: (req, params) =>
      handleUploadChunk(req, decodeURIComponent(params.id), new URL(req.url)),
  }),
  route({
    method: 'DELETE',
    path: '/api/files/upload/:id',
    handler: (_req, params) => handleUploadCancel(decodeURIComponent(params.id)),
  }),
];
