export {
  JSON_BODY_MAX_BYTES,
  readJsonObjectBody,
} from '@tmex/shared/http';

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

export function manifestJson(data: unknown, method: 'GET' | 'HEAD'): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
