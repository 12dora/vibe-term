import { statSync } from 'node:fs';
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

export function statFileIdentity(path: string): {
  size: number;
  mtimeMs: number;
  ino: number;
} | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) };
  } catch {
    return null;
  }
}

export function identityValidators(id: {
  size: number;
  mtimeMs: number;
  ino: number;
}): FileValidators {
  return {
    etag: strongEtag([id.size, id.mtimeMs, id.ino]),
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

/** RFC 9110 §13.1.5：etag 用强比较；日期与 Last-Modified 精确相等。 */
export function ifRangeAllowsPartial(ifRange: string | null, validators: FileValidators): boolean {
  if (ifRange === null) return true;
  const value = ifRange.trim();
  if (looksLikeEtag(value)) return strongEtagMatch(value, validators.etag);
  return validators.lastModified !== null && value === validators.lastModified;
}

export type PulledFileBody = {
  tmpPath: string;
  name: string;
  mime: string | null;
  cleanup: () => void;
};

export function servePulledFile(req: Request, file: PulledFileBody, attachment: boolean): Response {
  const identity = statFileIdentity(file.tmpPath);
  if (!identity) {
    file.cleanup();
    return codeError('unknown');
  }
  return serveFileBytes(req, {
    path: file.tmpPath,
    name: file.name,
    mime: file.mime,
    entityLength: identity.size,
    validators: identityValidators(identity),
    attachment,
    cleanupAfter: file.cleanup,
  });
}

export function serveFileBytes(req: Request, file: ServeFileInput): Response {
  const cleanup = once(file.cleanupAfter);
  const range = resolveRange(req, file.entityLength, file.validators);
  if (range === 'unsatisfiable') {
    cleanup();
    return unsatisfiableResponse(file.entityLength);
  }
  const body = openFileBody(file.path, range, file.cleanupAfter ? cleanup : undefined);
  if (!body) {
    cleanup();
    return codeError('unknown');
  }
  if (!range) {
    return new Response(body, { status: 200, headers: fileHeaders(file, file.entityLength) });
  }
  const length = range.end - range.start;
  return new Response(body, {
    status: 206,
    headers: {
      ...fileHeaders(file, length),
      'Content-Range': `bytes ${range.start}-${range.end - 1}/${file.entityLength}`,
    },
  });
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

/**
 * 无 cleanup 时用 `Bun.file`（有确定大小，Bun 会发真实 Content-Length）。
 * 需要在流结束删临时文件时退回 ReadableStream，Bun 会改成 chunked。
 */
function openFileBody(
  path: string,
  range: ContentRange | null,
  cleanupAfter?: () => void
): BodyInit | null {
  if (cleanupAfter) return streamFileRange(path, range, cleanupAfter);
  try {
    statSync(path);
  } catch {
    return null;
  }
  const file = Bun.file(path);
  return range ? file.slice(range.start, range.end) : file;
}

function looksLikeEtag(value: string): boolean {
  if (value.startsWith('"')) return true;
  return value.length >= 3 && value.startsWith('W/') && value[2] === '"';
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
