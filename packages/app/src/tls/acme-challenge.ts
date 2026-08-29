const PREFIX = '/.well-known/acme-challenge/';

export class AcmeHttp01Challenge {
  private readonly tokens = new Map<string, string>();

  set(token: string, keyAuth: string): void {
    this.tokens.set(token, keyAuth);
  }

  clear(token: string): void {
    this.tokens.delete(token);
  }

  handle(req: Request): Response | null {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(PREFIX)) {
      return null;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const token = decodeURIComponent(url.pathname.slice(PREFIX.length));
    if (!token || token.includes('/')) {
      return new Response('Not Found', { status: 404 });
    }
    const keyAuth = this.tokens.get(token);
    if (keyAuth === undefined) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(req.method === 'HEAD' ? null : keyAuth, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
