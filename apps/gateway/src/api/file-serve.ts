import { statSync } from 'node:fs';
import type { FileSourceIdentity, LocalFileHandle } from '../files/local-fs';
import {
  type ContentRange,
  attachmentHeaders,
  codeError,
  parseRangeHeader,
  streamFileRange,
} from './file-http';

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
  const range = resolveRange(req, file.entityLength, file.validators);
  if (range === 'unsatisfiable') {
    cleanup();
    return unsatisfiableResponse(file.entityLength);
  }
  const length = range ? range.end - range.start : file.entityLength;
  const headers = fileHeaders(file, length);
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end - 1}/${file.entityLength}`;
  }
  return sendOpenedFile(file, range, range ? 206 : 200, headers, cleanup);
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

function fileHeaders(file: ServeFileInput, bodyLength: number): Record<string, string> {
  const headers = file.attachment
    ? attachmentHeaders(file.name, file.mime, bodyLength)
    : inlineHeaders(file.mime, bodyLength);
  headers.ETag = file.validators.etag;
  headers[ENTITY_LENGTH_HEADER] = String(file.entityLength);
  if (!file.attachment) headers['Content-Disposition'] = 'inline';
  if (file.validators.lastModified) headers['Last-Modified'] = file.validators.lastModified;
  return headers;
}

function inlineHeaders(mime: string | null, bodyLength: number): Record<string, string> {
  return {
    'Content-Type': mime ?? 'application/octet-stream',
    'Content-Length': String(bodyLength),
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
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
  headers: Record<string, string>,
  cleanup: () => void
): Response {
  let body: BodyInit | null = null;
  try {
    const hdrs = new Headers(headers);
    const onClose = file.cleanupAfter ? cleanup : undefined;
    body = openFileBody(file.path, range, file.entityLength, onClose);
    if (!body) {
      cleanup();
      return codeError('unknown');
    }
    return new Response(body, { status, headers: hdrs });
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
