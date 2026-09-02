import { SetupError } from './setup-service';

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonErr(code: string, message: string, status: number): Response {
  return jsonOk({ error: { code, message } }, status);
}

export function mapError(error: unknown, fallback = 'internal_error'): Response {
  if (error instanceof SetupError) {
    return jsonErr(error.code, error.message, error.httpStatus);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonErr(fallback, message, 500);
}

export const JSON_BODY_MAX_BYTES = 1024 * 1024;

export async function readJsonBody(
  req: Request,
  maxBytes = JSON_BODY_MAX_BYTES
): Promise<Record<string, unknown> | null> {
  const bytes = await readBodyCapped(req, maxBytes);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const contentLength = req.headers.get('content-length');
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
