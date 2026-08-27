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

export async function readJsonObjectBody(req: Request): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
