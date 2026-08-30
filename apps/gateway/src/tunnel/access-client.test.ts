import { describe, expect, test } from 'bun:test';
import { CloudflareAccessClient, sanitizeAccessMessage } from './access-client';
import { parseAccessRules, toCloudflareInclude } from './access-rules';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CloudflareAccessClient', () => {
  test('looks up organization auth_domain', async () => {
    const urls: string[] = [];
    const client = new CloudflareAccessClient(async (input) => {
      urls.push(String(input));
      return jsonRes({ success: true, result: { auth_domain: 'team.cloudflareaccess.com' } });
    });
    const org = await client.getOrganization('acc1', 'tok');
    expect(org.teamDomain).toBe('team.cloudflareaccess.com');
    expect(urls[0]).toContain('/accounts/acc1/access/organizations');
    expect(urls[0]).toContain('https://api.cloudflare.com/client/v4');
  });

  test('creates a self_hosted app with domain/name/session_duration and reads id/aud', async () => {
    let body: unknown;
    const client = new CloudflareAccessClient(async (input, init) => {
      body = JSON.parse(String(init?.body));
      expect(String(input)).toContain('/accounts/acc1/access/apps');
      expect(init?.method).toBe('POST');
      return jsonRes({
        success: true,
        result: { id: 'app-1', aud: 'aud-1', name: 'tmex', domain: 'tmex.example.com' },
      });
    });
    const app = await client.createApp('acc1', 'tok', 'tmex.example.com');
    expect(app).toMatchObject({ id: 'app-1', aud: 'aud-1' });
    expect(body).toMatchObject({
      type: 'self_hosted',
      domain: 'tmex.example.com',
      session_duration: '24h',
    });
  });

  test('replaces a single allow policy and deletes extras', async () => {
    const calls: Array<{ method?: string; url: string; body?: unknown }> = [];
    const client = new CloudflareAccessClient(async (input, init) => {
      const url = String(input);
      const method = init?.method;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/policies') && method === 'GET') {
        return jsonRes({
          success: true,
          result: [
            { id: 'pol-1', include: [] },
            { id: 'pol-2', include: [] },
          ],
        });
      }
      if (url.endsWith('/policies/pol-1') && method === 'PUT') {
        return jsonRes({ success: true, result: { id: 'pol-1', include: body?.include } });
      }
      if (url.endsWith('/policies/pol-2') && method === 'DELETE') {
        return jsonRes({ success: true, result: null });
      }
      return jsonRes({ success: false, errors: [{ message: `unexpected ${method} ${url}` }] }, 400);
    });
    const rules = [{ kind: 'email' as const, value: 'a@example.com' }];
    await client.replaceAllowPolicy('acc1', 'tok', 'app-1', rules);
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/policies/pol-1'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/policies/pol-2'))).toBe(
      true
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({
      decision: 'allow',
      include: [{ email: { email: 'a@example.com' } }],
    });
  });

  test('maps Cloudflare error envelopes without leaking tokens', async () => {
    const client = new CloudflareAccessClient(async () =>
      jsonRes({ success: false, errors: [{ code: 10000, message: 'Invalid API Token' }] }, 401)
    );
    try {
      await client.getOrganization('acc1', 'super-secret-token-value-xxxxxxxx');
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toBe('Invalid API Token');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });

  test('paginates Access apps and matches hostname', async () => {
    const pages: string[] = [];
    const client = new CloudflareAccessClient(async (input) => {
      const url = String(input);
      pages.push(url);
      if (/[?&]page=1(?:&|$)/.test(url)) {
        return jsonRes({
          success: true,
          result: [{ id: 'app-a', aud: 'aud-a', domain: 'other.example.com', name: 'x' }],
          result_info: { page: 1, per_page: 100, total_count: 2, total_pages: 2 },
        });
      }
      if (/[?&]page=2(?:&|$)/.test(url)) {
        return jsonRes({
          success: true,
          result: [{ id: 'app-b', aud: 'aud-b', domain: 'tmex.example.com', name: 'tmex' }],
          result_info: { page: 2, per_page: 100, total_count: 2, total_pages: 2 },
        });
      }
      return jsonRes({ success: false, errors: [{ message: url }] }, 400);
    });
    const apps = await client.listApps('acc1', 'tok');
    expect(apps.map((a) => a.id)).toEqual(['app-a', 'app-b']);
    expect(client.findAppForHostname(apps, 'tmex.example.com')?.id).toBe('app-b');
    expect(pages.some((u) => u.includes('page=2'))).toBe(true);
  });

  test('reads remotely-managed tunnel ingress and name', async () => {
    const client = new CloudflareAccessClient(async (input) => {
      const url = String(input);
      if (url.endsWith('/cfd_tunnel/tid/configurations')) {
        return jsonRes({
          success: true,
          result: {
            config: {
              ingress: [
                { hostname: 'tmex.example.com', service: 'http://127.0.0.1:19883' },
                { service: 'http_status:404' },
              ],
            },
          },
        });
      }
      if (url.endsWith('/cfd_tunnel/tid')) {
        return jsonRes({ success: true, result: { id: 'tid', name: 'tmex-ext' } });
      }
      return jsonRes({ success: false, errors: [{ message: url }] }, 400);
    });
    const ingress = await client.getTunnelIngress('acc1', 'tok', 'tid');
    expect(ingress).toEqual([
      { hostname: 'tmex.example.com', service: 'http://127.0.0.1:19883' },
      { hostname: null, service: 'http_status:404' },
    ]);
    expect(await client.getTunnel('acc1', 'tok', 'tid')).toEqual({
      id: 'tid',
      name: 'tmex-ext',
    });
  });
});

describe('access rule helpers', () => {
  test('parses and rejects invalid emails/domains', () => {
    expect(parseAccessRules([{ kind: 'email', value: '  A@Ex.com ' }])).toEqual([
      { kind: 'email', value: 'a@ex.com' },
    ]);
    expect(() => parseAccessRules([])).toThrow();
    expect(() => parseAccessRules([{ kind: 'email', value: 'not-an-email' }])).toThrow();
    expect(toCloudflareInclude([{ kind: 'email_domain', value: 'example.com' }])).toEqual([
      { email_domain: { domain: 'example.com' } },
    ]);
  });

  test('sanitizeAccessMessage redacts long secrets', () => {
    expect(sanitizeAccessMessage('token=abcdefghijklmnopqrstuvwxyz0123456789ABCD')).not.toContain(
      'abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    );
  });
});
