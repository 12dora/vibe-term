export type RuntimeMode = 'normal' | 'preflight';

export const RUNTIME_MODE_ENV = 'TMEX_RUNTIME_MODE';

export function readRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return env[RUNTIME_MODE_ENV] === 'preflight' ? 'preflight' : 'normal';
}

export function preflightHealthzBody(version: string, startedAt: number) {
  return { status: 'ok' as const, version, startedAt };
}

export function handlePreflightHttp(req: Request, version: string, startedAt: number): Response {
  const path = new URL(req.url).pathname;
  if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
    return Response.json(preflightHealthzBody(version, startedAt));
  }
  return new Response('Not Found', { status: 404 });
}
