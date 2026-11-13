import { statSync } from 'node:fs';
import type { FileSourceIdentity, LocalFileHandle } from '../files/local-fs';
import { applySafeFileHeaders } from '../files/safe-file-headers';
import { contentDisposition } from './content-disposition';
import { type ContentRange, codeError, parseRangeHeader, streamFileRange } from './file-http';

export const ENTITY_LENGTH_HEADER = 'X-VibeTerm-Entity-Length';

export type FileValidators = {
  etag: string;
  lastModified: string | null;
};

export type ServeFileInput = {
  path: string;
  name: string;
  mime: string | null;
  entityLength: number;
  validators: FileValidators;
  attachment: boolean;
  cleanupAfter?: () => void;
};

export function strongEtag(parts: ReadonlyArray<string | number>): string {
  return `"${parts.join(':')}"`;
}

export function httpDate(mtimeMs: number): string {
  return new Date(mtimeMs).toUTCString();
}

export function identityValidators(id: FileSourceIdentity): FileValidators {
  return {
    etag: strongEtag([identityDigest(id)]),
    lastModified: httpDate(id.mtimeMs),
  };
}

export function sessionValidators(session: {
  id: string;
  size: number;
  sourceMtimeMs: number | null;
}): FileValidators {
  return {
    etag: strongEtag([session.id, session.size, session.sourceMtimeMs ?? 0]),
    lastModified: session.sourceMtimeMs != null ? httpDate(session.sourceMtimeMs) : null,
  };
}

/** 这些端点一律发强 ETag：If-Range 只接受精确强 ETag；日期或弱 ETag 忽略 Range。 */
export function ifRangeAllowsPartial(ifRange: string | null, validators: FileValidators): boolean {
  if (ifRange === null) return true;
  return strongEtagMatch(ifRange.trim(), validators.etag);
}

export type PulledFileBody = LocalFileHandle;

export function servePulledFile(req: Request, file: PulledFileBody, attachment: boolean): Response {
  return serveFileBytes(req, {
    path: file.tmpPath,
    name: file.name,
    mime: file.mime,
    entityLength: file.size,
    validators: identityValidators(file.source),
    attachment,
    cleanupAfter: file.temporary ? file.cleanup : undefined,
  });
}

export function serveFileBytes(req: Request, file: ServeFileInput): Response {
  const cleanup = once(file.cleanupAfter);
  try {
    const range = resolveRange(req, file.entityLength, file.validators);
    if (range === 'unsatisfiable') {
      cleanup();
      return unsatisfiableResponse(file.entityLength);
    }
    const length = range ? range.end - range.start : file.entityLength;
    const headers = fileHeaders(req, file, length);
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end - 1}/${file.entityLength}`);
    }
    return sendOpenedFile(file, range, range ? 206 : 200, headers, cleanup);
  } catch {
    cleanup();
    return codeError('unknown');
  }
}

function identityDigest(id: FileSourceIdentity): string {
  const key = 'path' in id ? `p:${id.path}` : `i:${id.ino}`;
  return Bun.hash(`${id.size}:${id.mtimeMs}:${key}`).toString(16);
}

function resolveRange(
  req: Request,
  size: number,
  validators: FileValidators
): ContentRange | null | 'unsatisfiable' {
  const header = req.headers.get('range');
  if (!header) return null;
  if (!ifRangeAllowsPartial(req.headers.get('if-range'), validators)) return null;
  return parseRangeHeader(header, size);
}

function fileHeaders(req: Request, file: ServeFileInput, bodyLength: number): Headers {
  const headers = new Headers({
    'Content-Length': String(bodyLength),
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    ETag: file.validators.etag,
    [ENTITY_LENGTH_HEADER]: String(file.entityLength),
  });
  if (file.validators.lastModified) headers.set('Last-Modified', file.validators.lastModified);
  applySafeFileHeaders(headers, {
    contentType: file.mime,
    disposition: contentDisposition(file.name, file.attachment ? 'attachment' : 'inline'),
    req,
  });
  return headers;
}

function unsatisfiableResponse(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'Content-Range': `bytes */${size}`,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    },
  });
}

function sendOpenedFile(
  file: ServeFileInput,
  range: ContentRange | null,
  status: number,
  headers: Headers,
  cleanup: () => void
): Response {
  let body: BodyInit | null = null;
  try {
    const onClose = file.cleanupAfter ? cleanup : undefined;
    body = openFileBody(file.path, range, file.entityLength, onClose);
    if (!body) {
      cleanup();
      return codeError('unknown');
    }
    return new Response(body, { status, headers });
  } catch {
    if (body instanceof ReadableStream) void body.cancel();
    cleanup();
    return codeError('unknown');
  }
}

/**
 * 无 cleanup 时用 `Bun.file`（有确定大小，Bun 会发真实 Content-Length）。
 * 需要在流结束删临时文件时退回 ReadableStream，Bun 会改成 chunked。
 * 无 Range 时按 stat 时的 entityLength 切片，避免本地文件增长后多发字节。
 */
function openFileBody(
  path: string,
  range: ContentRange | null,
  entityLength: number,
  cleanupAfter?: () => void
): BodyInit | null {
  const span = range ?? { start: 0, end: entityLength };
  if (cleanupAfter) return streamFileRange(path, span, cleanupAfter);
  try {
    statSync(path);
  } catch {
    return null;
  }
  return Bun.file(path).slice(span.start, span.end);
}

function strongEtagMatch(received: string, ours: string): boolean {
  if (received.startsWith('W/') || ours.startsWith('W/')) return false;
  return received === ours;
}

function once(fn?: () => void): () => void {
  let done = false;
  return () => {
    if (done || !fn) return;
    done = true;
    fn();
  };
}
