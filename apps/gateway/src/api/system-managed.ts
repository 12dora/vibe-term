import { MANAGED_EXTERNALLY, getSystemInfo } from '../system/info-public';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function handleManagedSystemApiRequest(req: Request, path: string): Response | undefined {
  if (path === '/api/system/info' && req.method === 'GET') {
    return json(getSystemInfo());
  }

  if (path === '/api/system/update-check' || path === '/api/system/upgrade') {
    return json(
      {
        error: MANAGED_EXTERNALLY,
        managed: true,
        canSelfUpdate: false,
      },
      403
    );
  }

  return undefined;
}
