import { MANAGED_EXTERNALLY, getSystemInfo } from '../system/info-public';
import { json } from './http';

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
