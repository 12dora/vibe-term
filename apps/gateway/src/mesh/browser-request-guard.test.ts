import { describe, expect, test } from 'bun:test';
import {
  type BrowserRequestGuardDeps,
  FOREIGN_ORIGIN,
  MISDIRECTED_HOST,
  guardBrowserRequest,
} from './browser-request-guard';
import { ownMdnsName } from './domain-access-policy';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';

const ENTRY = 'http://127.0.0.1:9883';

function request(
  url: string,
  init: RequestInit & { via?: string; trustProxy?: boolean } = {}
): Request {
  const { via = MESH_VIA_SELF, trustProxy = false, ...rest } = init;
  const req = new Request(url, rest);
  setMeshRequestContext(req, { via, trustProxy, ...(trustProxy ? { clientIp: '127.0.0.1' } : {}) });
  return req;
}

function deps(overrides: Partial<BrowserRequestGuardDeps> = {}): BrowserRequestGuardDeps {
  return {
    openAccess: () => false,
    entryOrigins: () => ['https://vt.example.com', null],
    configuredHosts: () => ['vt.example.com'],
    ...overrides,
  };
}

const upgrade = (origin?: string): HeadersInit => ({
  upgrade: 'websocket',
  ...(origin ? { origin } : {}),
});

describe('guardBrowserRequest: Origin', () => {
  test('WebSocket upgrade: foreign origin 403, same origin and no origin pass', async () => {
    const foreign = guardBrowserRequest(
      request(`${ENTRY}/ws`, { headers: upgrade('http://127.0.0.1:8080') }),
      deps()
    );
    expect(foreign?.status).toBe(403);
    expect(await foreign?.text()).toBe(FOREIGN_ORIGIN);
    expect(foreign?.headers.get('content-type')).toStartWith('text/plain');
    expect(guardBrowserRequest(request(`${ENTRY}/ws`, { headers: upgrade(ENTRY) }), deps())).toBe(
      null
    );
    expect(guardBrowserRequest(request(`${ENTRY}/ws`, { headers: upgrade() }), deps())).toBe(null);
  });

  test('state-changing /api request with a foreign origin gets a JSON 403', async () => {
    for (const path of ['/api/exec', '/n/peer/api/exec']) {
      const res = guardBrowserRequest(
        request(`${ENTRY}${path}`, { method: 'POST', headers: { origin: 'https://evil.example' } }),
        deps()
      );
      expect(res?.status).toBe(403);
      expect(await res?.json()).toEqual({ error: { code: FOREIGN_ORIGIN } });
    }
  });

  test('Origin: null and non-http origins are foreign', () => {
    for (const origin of ['null', 'file://', 'chrome-extension://abc', 'not a url']) {
      const res = guardBrowserRequest(
        request(`${ENTRY}/api/settings`, { method: 'PATCH', headers: { origin } }),
        deps()
      );
      expect(res?.status).toBe(403);
    }
  });

  test('Sec-Fetch-Site: cross-site is refused even without Origin', () => {
    const res = guardBrowserRequest(
      request(`${ENTRY}/api/exec`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }),
      deps()
    );
    expect(res?.status).toBe(403);
    const sameSite = guardBrowserRequest(
      request(`${ENTRY}/api/exec`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      deps()
    );
    expect(sameSite).toBe(null);
  });

  test('safe methods are not origin-checked', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = guardBrowserRequest(
        request(`${ENTRY}/api/devices`, {
          method,
          headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        }),
        deps()
      );
      expect(res).toBe(null);
    }
  });

  test('configured entry origins pass even when the request host differs', () => {
    const res = guardBrowserRequest(
      request(`${ENTRY}/api/exec`, {
        method: 'POST',
        headers: { origin: 'https://VT.example.com:443' },
      }),
      deps()
    );
    expect(res).toBe(null);
  });

  test('trusted proxy: Origin is compared with the forwarded public URL', () => {
    const headers = {
      origin: 'https://vt2.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'vt2.example.com',
    };
    const trusted = request(`${ENTRY}/api/exec`, { method: 'POST', headers, trustProxy: true });
    expect(guardBrowserRequest(trusted, deps())).toBe(null);
    const untrusted = request(`${ENTRY}/api/exec`, { method: 'POST', headers });
    expect(guardBrowserRequest(untrusted, deps())?.status).toBe(403);
  });

  test('TLS terminated in front: https origin on the same host passes, http origin on an https request does not', () => {
    const upgraded = request('http://vt2.example.com/api/exec', {
      method: 'POST',
      headers: { origin: 'https://vt2.example.com' },
    });
    expect(guardBrowserRequest(upgraded, deps())).toBe(null);
    const downgraded = request('https://vt2.example.com/api/exec', {
      method: 'POST',
      headers: { origin: 'http://vt2.example.com' },
    });
    expect(guardBrowserRequest(downgraded, deps())?.status).toBe(403);
    const otherPort = request('http://vt2.example.com/api/exec', {
      method: 'POST',
      headers: { origin: 'http://vt2.example.com:8080' },
    });
    expect(guardBrowserRequest(otherPort, deps())?.status).toBe(403);
  });

  test('peer-inbound requests are not browser requests', () => {
    const res = guardBrowserRequest(
      request(`${ENTRY}/api/exec`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        via: 'cd'.repeat(16),
      }),
      deps({ openAccess: () => true })
    );
    expect(res).toBe(null);
  });
});

describe('guardBrowserRequest: Host (open standalone only)', () => {
  const open = deps({ openAccess: () => true });

  test('rebinding host is 421; local, IP and configured hosts pass', async () => {
    const rebound = guardBrowserRequest(request('http://attacker.example:9883/api/devices'), open);
    expect(rebound?.status).toBe(421);
    expect(await rebound?.json()).toEqual({ error: { code: MISDIRECTED_HOST } });
    for (const host of [
      '127.0.0.1:9883',
      '192.168.1.20:9883',
      '[::1]:9883',
      'localhost:9883',
      'vt.localhost',
      `${ownMdnsName()}:9883`,
      'vt.example.com',
      'vt.example.com:8443',
    ]) {
      expect(guardBrowserRequest(request(`http://${host}/api/devices`), open)).toBe(null);
    }
  });

  test("a .local name other than this machine's is 421", () => {
    const res = guardBrowserRequest(request('http://other-box.local:9883/api/devices'), open);
    expect(res?.status).toBe(421);
  });

  test('a rebinding page cannot launder its Host through X-Forwarded-Host', () => {
    const req = request('http://attacker.example/api/devices', {
      headers: { 'x-forwarded-host': '127.0.0.1:9883', 'x-forwarded-proto': 'http' },
      trustProxy: true,
    });
    expect(guardBrowserRequest(req, open)?.status).toBe(421);
  });

  test('behind a trusted proxy the forwarded host must be allowed too', () => {
    const req = request(`${ENTRY}/`, {
      headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
      trustProxy: true,
    });
    expect(guardBrowserRequest(req, open)?.status).toBe(421);
  });

  test('authenticated mode does not check Host', () => {
    expect(guardBrowserRequest(request('http://attacker.example/api/devices'), deps())).toBe(null);
  });
});
