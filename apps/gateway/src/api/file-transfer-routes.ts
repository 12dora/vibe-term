import { config } from '../config';
import {
  pullFileFromDevice,
  pushFileToDevice,
  sanitizeUploadName,
  statFile,
} from '../files/device-storage';
import { transferMaxBytesNow } from '../files/transfer-limit';
import {
  createDownloadSession,
  createUploadSession,
  downloadSourceChanged,
  getDownloadSession,
  getUploadSession,
  uploadRanges,
  writeUploadRange,
} from '../files/transfer-session';
import { t } from '../i18n';
import { requestDispatchContext } from '../mesh/types';
import {
  type ContentRange,
  attachmentHeaders,
  codeError,
  ndjsonResponse,
  parseNonNegativeSafeInt,
  parseRangeHeader,
  streamFileRange,
  streamTempFile,
} from './file-http';
import { cleanupDownload, cleanupUpload, rememberTransferUid } from './file-transfer-sessions';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function uidFromRequest(req: Request): string {
  return requestDispatchContext.get(req)?.uid ?? '';
}

/** 复用既有 `too_large`（413）形状，前端已认这一路；额外带上生效上限便于提示。 */
function tooLargeFor(maxBytes: number): Response {
  return json({ error: 'too_large', code: 'too_large', maxBytes }, 413);
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
  // 生效上限 = 本机配置与中继下发的单文件上限取小；超限把上限一并回给前端。
  const maxBytes = transferMaxBytesNow(config.transferMaxBytes);
  if (size > maxBytes) return tooLargeFor(maxBytes);

  const stat = await statFile(rootId, destDir);
  if (!stat.ok) return codeError(stat.code, stat.detail);
  if (stat.data.type !== 'dir') return codeError('not_a_directory');

  const session = createUploadSession({ rootId, destDir, name, size });
  rememberTransferUid(session.id, uidFromRequest(req));
  return json({ uploadId: session.id, chunkSize: UPLOAD_CHUNK_SIZE, ranged: true });
}

/** 本次 PUT 声明的字节数：优先 `length` 查询参数，其次 content-length。 */
function declaredLength(req: Request, url: URL): number | null | 'invalid' {
  const raw = url.searchParams.get('length');
  if (raw !== null) {
    const parsed = parseNonNegativeSafeInt(raw);
    return parsed === null ? 'invalid' : parsed;
  }
  const header = req.headers.get('Content-Length');
  if (header === null) return null;
  const parsed = parseNonNegativeSafeInt(header);
  return parsed === null ? 'invalid' : parsed;
}

const EMPTY_BODY = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

function uploadFailure(reason: string): Response {
  if (reason === 'not_found' || reason === 'cancelled') return codeError('not_found');
  if (reason === 'too_large') return codeError('too_large');
  return json({ error: t('apiError.invalidRequest') }, 409);
}

async function handleUploadChunk(req: Request, id: string, url: URL): Promise<Response> {
  const offset = parseNonNegativeSafeInt(url.searchParams.get('offset'));
  if (offset === null) return json({ error: t('apiError.invalidRequest') }, 400);
  const session = getUploadSession(id);
  if (!session) return codeError('not_found');

  const declared = declaredLength(req, url);
  if (declared === 'invalid') return json({ error: t('apiError.invalidRequest') }, 400);
  if (declared !== null) {
    if (declared > UPLOAD_CHUNK_SIZE) return codeError('too_large');
    if (offset + declared > session.size) return codeError('too_large');
  }

  const res = await writeUploadRange(id, {
    offset,
    contentLength: declared ?? undefined,
    // 单次 PUT 的上限与客户端声明无关：不带 length / content-length 的分块请求
    // 也不能一口气吃掉整个文件配额。
    maxWriteBytes: Math.max(0, Math.min(UPLOAD_CHUNK_SIZE, session.size - offset)),
    body: req.body ?? EMPTY_BODY(),
  });
  if (!res.ok) return uploadFailure(res.reason);
  return json({ received: res.received, complete: res.complete });
}

function handleUploadCommit(id: string): Response {
  const session = getUploadSession(id);
  if (!session) return codeError('not_found');
  if (!session.complete) return codeError('invalid', 'incomplete upload');
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

/** 续传用：客户端断线重连后先问这里已经收了哪些区间，只补发缺口。 */
async function handleUploadStatus(id: string): Promise<Response> {
  const session = getUploadSession(id);
  if (!session) return codeError('not_found');
  return json({
    size: session.size,
    received: session.received,
    complete: session.complete,
    ranges: await uploadRanges(session.id),
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

/** 支持 `Range`：客户端断线后可以从已收偏移接着拉，不必重跑一次 prepare。 */
function handleDownloadContent(req: Request, id: string): Response {
  const session = getDownloadSession(id);
  if (!session) return codeError('not_found');
  if (downloadSourceChanged(session)) {
    cleanupDownload(id);
    return codeError('invalid', 'source changed');
  }
  const range = parseRangeHeader(req.headers.get('range'), session.size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${session.size}`, 'Cache-Control': 'no-store' },
    });
  }
  // 会话只由客户端显式 DELETE 或 TTL 回收：读到文件尾不代表客户端真的收全了，
  // 就地清掉会让紧接着的续传请求撞上 404。
  const body = streamFileRange(session.tmpPath, range);
  if (!body) return codeError('unknown');
  if (range === null) {
    return new Response(body, {
      status: 200,
      headers: attachmentHeaders(session.name, session.mime, session.size),
    });
  }
  return new Response(body, { status: 206, headers: rangeHeaders(session, range) });
}

function rangeHeaders(
  session: { name: string; mime: string | null; size: number },
  range: ContentRange
): Record<string, string> {
  return {
    ...attachmentHeaders(session.name, session.mime, range.end - range.start),
    'Content-Range': `bytes ${range.start}-${range.end - 1}/${session.size}`,
  };
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
    handler: (req, params) => handleDownloadContent(req, decodeURIComponent(params.id)),
  }),
  route({
    method: 'DELETE',
    path: '/api/files/download/:id',
    handler: (_req, params) => handleDownloadCancel(decodeURIComponent(params.id)),
  }),
  route({
    method: 'GET',
    path: '/api/files/upload/:id',
    handler: (_req, params) => handleUploadStatus(decodeURIComponent(params.id)),
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
