import { afterEach, describe, expect, test } from 'bun:test';
import { meshFetch, setMeshProxyPolicyForTests } from './mesh-egress';
import { resetMeshEgressProxyLogForTests } from './mesh-egress-proxy';
import { resetMeshProxyStoreForTests } from './mesh-proxy-store';

const PROXY_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

const saved: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const key of PROXY_KEYS) saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of PROXY_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearProxyEnv(): void {
  for (const key of PROXY_KEYS) delete process.env[key];
}

afterEach(() => {
  restoreEnv();
  setMeshProxyPolicyForTests(null);
  resetMeshEgressProxyLogForTests();
  resetMeshProxyStoreForTests();
});

function setProxyEnv(proxyUrl: string): void {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.ALL_PROXY = proxyUrl;
  process.env.NO_PROXY = '';
  process.env.no_proxy = '';
}

describe('meshFetch policy', () => {
  test('direct 即使设了 HTTP_PROXY 也不碰假代理', async () => {
    saveEnv();
    const proxyHits: string[] = [];
    const target = Bun.serve({
      hostname: '127.0.0.3',
      port: 0,
      fetch() {
        return new Response('target-ok');
      },
    });
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxyHits.push(req.url);
        return new Response('from-proxy');
      },
    });
    try {
      setProxyEnv(`http://127.0.0.1:${proxy.port}`);
      setMeshProxyPolicyForTests('direct');
      const res = await meshFetch(`http://127.0.0.3:${target.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('target-ok');
      expect(proxyHits).toEqual([]);
    } finally {
      target.stop(true);
      proxy.stop(true);
    }
  });

  test('system 公网主机走环境代理', async () => {
    saveEnv();
    const proxyHits: string[] = [];
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxyHits.push(`${req.method} ${req.url}`);
        return new Response('from-proxy');
      },
    });
    try {
      setProxyEnv(`http://127.0.0.1:${proxy.port}`);
      setMeshProxyPolicyForTests('system');
      const res = await meshFetch('http://relay.example/');
      expect(await res.text()).toBe('from-proxy');
      expect(proxyHits.length).toBeGreaterThan(0);
    } finally {
      proxy.stop(true);
    }
  });

  test('system 私网字面量直连，假代理 0 次命中', async () => {
    saveEnv();
    const proxyHits: string[] = [];
    const target = Bun.serve({
      hostname: '127.0.0.3',
      port: 0,
      fetch() {
        return new Response('target-ok');
      },
    });
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxyHits.push(req.url);
        return new Response('from-proxy');
      },
    });
    try {
      setProxyEnv(`http://127.0.0.1:${proxy.port}`);
      setMeshProxyPolicyForTests('system');
      const res = await meshFetch(`http://127.0.0.3:${target.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('target-ok');
      expect(proxyHits).toEqual([]);
    } finally {
      target.stop(true);
      proxy.stop(true);
    }
  });

  test('system 括号公网 IPv6 命中 NO_PROXY 则不走代理', async () => {
    saveEnv();
    const proxyHits: string[] = [];
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxyHits.push(req.url);
        return new Response('from-proxy');
      },
    });
    try {
      setProxyEnv(`http://127.0.0.1:${proxy.port}`);
      process.env.NO_PROXY = '2001:db8::1';
      process.env.no_proxy = '2001:db8::1';
      setMeshProxyPolicyForTests('system');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 300);
      try {
        await meshFetch('http://[2001:db8::1]/', { signal: ac.signal });
      } catch {
        // 直连文档前缀会失败或被中止
      } finally {
        clearTimeout(timer);
      }
      expect(proxyHits).toEqual([]);
    } finally {
      proxy.stop(true);
    }
  });

  test('system CIDR NO_PROXY 命中公网字面量则不走代理', async () => {
    saveEnv();
    const proxyHits: string[] = [];
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxyHits.push(req.url);
        return new Response('from-proxy');
      },
    });
    try {
      setProxyEnv(`http://127.0.0.1:${proxy.port}`);
      process.env.NO_PROXY = '203.0.113.0/24';
      process.env.no_proxy = '203.0.113.0/24';
      setMeshProxyPolicyForTests('system');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 300);
      try {
        await meshFetch('http://203.0.113.50/', { signal: ac.signal });
      } catch {
        // TEST-NET 直连失败或中止
      } finally {
        clearTimeout(timer);
      }
      expect(proxyHits).toEqual([]);
    } finally {
      proxy.stop(true);
    }
  });

  test('AbortSignal 中止未完成的请求', async () => {
    saveEnv();
    clearProxyEnv();
    setMeshProxyPolicyForTests('direct');
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        await Bun.sleep(10_000);
        return new Response('late');
      },
    });
    const ac = new AbortController();
    const pending = meshFetch(`http://127.0.0.1:${target.port}/`, { signal: ac.signal });
    ac.abort();
    try {
      await expect(pending).rejects.toBeTruthy();
    } finally {
      target.stop(true);
    }
  });

  test('流式响应体可按块读取', async () => {
    saveEnv();
    clearProxyEnv();
    setMeshProxyPolicyForTests('direct');
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('hello '));
              controller.enqueue(new TextEncoder().encode('world'));
              controller.close();
            },
          })
        );
      },
    });
    try {
      const res = await meshFetch(`http://127.0.0.1:${target.port}/stream`);
      expect(await res.text()).toBe('hello world');
    } finally {
      target.stop(true);
    }
  });

  test('直连失败保留 ECONNREFUSED code', async () => {
    saveEnv();
    clearProxyEnv();
    setMeshProxyPolicyForTests('direct');
    try {
      await meshFetch('http://127.0.0.1:59999/');
      throw new Error('expected connect failure');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ECONNREFUSED');
    }
  });
});

describe('meshFetch body', () => {
  test('URLSearchParams / Blob / ReadableStream / Request 体都能发出', async () => {
    saveEnv();
    clearProxyEnv();
    setMeshProxyPolicyForTests('direct');
    const seen: { ct: string | null; body: string }[] = [];
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        seen.push({ ct: req.headers.get('content-type'), body: await req.text() });
        return new Response('ok');
      },
    });
    try {
      const url = `http://127.0.0.1:${target.port}/`;
      await meshFetch(url, { method: 'POST', body: new URLSearchParams({ a: '1' }) });
      await meshFetch(url, { method: 'POST', body: new Blob(['blob-body']) });
      await meshFetch(url, {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('stream-body'));
            controller.close();
          },
        }),
      });
      await meshFetch(new Request(url, { method: 'POST', body: 'request-body' }));
      const req = new Request(url, { method: 'POST', body: 'from-req' });
      await meshFetch(req, { body: 'from-init' });
      expect(seen.map((row) => row.body)).toEqual([
        'a=1',
        'blob-body',
        'stream-body',
        'request-body',
        'from-init',
      ]);
      expect(seen[0]?.ct ?? '').toContain('application/x-www-form-urlencoded');
    } finally {
      target.stop(true);
    }
  });
});

describe('meshFetch user-agent', () => {
  test('直连路径默认带 vibeterm UA，调用方显式给的不覆盖', async () => {
    saveEnv();
    clearProxyEnv();
    setMeshProxyPolicyForTests('direct');
    const seen: (string | null)[] = [];
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        seen.push(req.headers.get('user-agent'));
        return new Response('ok');
      },
    });
    try {
      const url = `http://127.0.0.1:${target.port}/`;
      await (await meshFetch(url)).text();
      await (await meshFetch(url, { headers: { 'User-Agent': 'custom/1' } })).text();
      expect(seen[0]).toMatch(/^vibeterm\//);
      expect(seen[1]).toBe('custom/1');
    } finally {
      target.stop(true);
    }
  });
});
