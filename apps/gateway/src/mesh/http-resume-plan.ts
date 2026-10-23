export const ENTITY_LENGTH_HEADER = 'x-vibeterm-entity-length';

export type ResumeValidator = { header: 'etag' | 'last-modified'; value: string };

export type ResumePlan = {
  start: number;
  end: number;
  total: number;
  validator: ResumeValidator;
};

/** GET 200/206 且带字节 Range、强校验器和已知实体长度时才能续传。两端共用。 */
export function resumePlanFrom(
  method: string,
  status: number,
  response: Headers
): ResumePlan | null {
  if (method.toUpperCase() !== 'GET') return null;
  if (status !== 200 && status !== 206) return null;
  if ((response.get('accept-ranges') ?? '').trim().toLowerCase() !== 'bytes') return null;
  const validator = responseValidator(response);
  if (!validator) return null;
  const total = entityLengthOf(status, response);
  if (total == null || total <= 0) return null;
  const span = responseSpan(status, response, total);
  if (!span) return null;
  return { ...span, total, validator };
}

export function headersFrom(headers: Headers | Record<string, string> | null | undefined): Headers {
  if (headers instanceof Headers) return headers;
  return new Headers(headers ?? undefined);
}

export function parseContentRange(
  value: string | null
): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(total)) return null;
  if (start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

function responseValidator(headers: Headers): ResumeValidator | null {
  const etag = headers.get('etag')?.trim() ?? '';
  if (etag && !etag.toLowerCase().startsWith('w/')) return { header: 'etag', value: etag };
  const lastModified = headers.get('last-modified')?.trim() ?? '';
  if (lastModified) return { header: 'last-modified', value: lastModified };
  return null;
}

function entityLengthOf(status: number, headers: Headers): number | null {
  if (status === 206) {
    return parseContentRange(headers.get('content-range'))?.total ?? entityLengthHeader(headers);
  }
  return headerInt(headers, 'content-length') ?? entityLengthHeader(headers);
}

function responseSpan(
  status: number,
  response: Headers,
  total: number
): { start: number; end: number } | null {
  if (status !== 206) return { start: 0, end: total - 1 };
  const range = parseContentRange(response.get('content-range'));
  if (!range || range.total !== total) return null;
  return { start: range.start, end: range.end };
}

function entityLengthHeader(headers: Headers): number | null {
  return headerInt(headers, ENTITY_LENGTH_HEADER);
}

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}
