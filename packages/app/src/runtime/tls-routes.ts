import { TlsApiError } from '../tls/errors';
import type { ApplyModeInput, TlsService } from '../tls/tls-service';

export type TlsRouteAuthorize = (req: Request) => Promise<Response | null>;

export function createTlsRoutes(deps: {
  service: TlsService;
  authorize: TlsRouteAuthorize;
}): (req: Request) => Promise<Response | null> {
  return async (req) => {
    const challenge = deps.service.handleChallenge(req);
    if (challenge) return challenge;

    const url = new URL(req.url);
    const path = url.pathname;
    if (path !== '/api/tls' && path !== '/api/tls/renew' && path !== '/api/tls/ca.crt') {
      return null;
    }

    if (path === '/api/tls/ca.crt' && req.method === 'GET') {
      const pem = await deps.service.caPem();
      if (!pem) {
        return errorJson('no_ca', 404, 'no self-signed CA is available');
      }
      return new Response(pem, {
        status: 200,
        headers: {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="tmex-ca.crt"',
        },
      });
    }

    const denied = await deps.authorize(req);
    if (denied) return denied;

    try {
      if (path === '/api/tls' && req.method === 'GET') {
        return json(await deps.service.status());
      }
      if (path === '/api/tls' && req.method === 'PUT') {
        const body = await readJson(req);
        if (!body) {
          return errorJson('tls_failed', 400, 'request body must be a JSON object');
        }
        return json(await deps.service.applyMode(parseApplyMode(body)));
      }
      if (path === '/api/tls/renew' && req.method === 'POST') {
        return json(await deps.service.renew());
      }
      return errorJson('method_not_allowed', 405, 'method not allowed');
    } catch (error) {
      if (error instanceof TlsApiError) {
        return errorJson(error.code, error.status, error.message);
      }
      return errorJson('tls_failed', 500, error instanceof Error ? error.message : String(error));
    }
  };
}

function parseApplyMode(body: Record<string, unknown>): ApplyModeInput {
  const mode = body.mode;
  if (mode === 'none') {
    return { mode: 'none' };
  }
  if (mode === 'external') {
    if (typeof body.trustProxy !== 'boolean') {
      throw new TlsApiError('tls_failed', 400, 'trustProxy must be a boolean');
    }
    return { mode: 'external', trustProxy: body.trustProxy };
  }
  if (mode === 'selfsigned') {
    if (!Array.isArray(body.sans) || !body.sans.every((item) => typeof item === 'string')) {
      throw new TlsApiError('invalid_sans', 400, 'sans must be an array of strings');
    }
    return {
      mode: 'selfsigned',
      sans: body.sans,
      tlsPort: asNumber(body.tlsPort, 'tlsPort'),
      bindHost: asString(body.bindHost, 'bindHost'),
    };
  }
  if (mode === 'acme') {
    const challenge = body.challenge;
    if (challenge !== 'http-01' && challenge !== 'dns-01') {
      throw new TlsApiError('invalid_domain', 400, 'challenge must be http-01 or dns-01');
    }
    const cloudflareToken =
      typeof body.cloudflareToken === 'string' ? body.cloudflareToken : undefined;
    return {
      mode: 'acme',
      domain: asString(body.domain, 'domain'),
      email: asString(body.email, 'email'),
      challenge,
      cloudflareToken,
      staging: Boolean(body.staging),
      tlsPort: asNumber(body.tlsPort, 'tlsPort'),
      bindHost: asString(body.bindHost, 'bindHost'),
    };
  }
  throw new TlsApiError('tls_failed', 400, 'mode is required');
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TlsApiError('tls_failed', 400, `${field} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TlsApiError('invalid_port', 400, `${field} must be a number`);
  }
  return value;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorJson(code: string, status: number, message: string): Response {
  return json({ error: { code, message } }, status);
}
