import { afterEach, describe, expect, test } from 'bun:test';
import {
  installMeshFetchForTests,
  meshWebSocket,
  resolveMeshWebSocketProxy,
  setMeshProxyPolicyForTests,
} from './mesh-egress';
import { httpProxyUrlFor, resetMeshEgressProxyLogForTests } from './mesh-egress-proxy';
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
  resetMeshEgressProxyLogForTests();
  setMeshProxyPolicyForTests(null);
  installMeshFetchForTests(null);
  resetMeshProxyStoreForTests();
});

describe('httpProxyUrlFor', () => {
  test('HTTPS 优先 HTTPS_PROXY，http(s) scheme 才采用', () => {
    saveEnv();
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    process.env.HTTP_PROXY = 'http://127.0.0.1:3128';
    expect(httpProxyUrlFor(new URL('https://relay.example/health'))).toBe('http://127.0.0.1:8080/');
    expect(httpProxyUrlFor(new URL('http://relay.example/health'))).toBe('http://127.0.0.1:3128/');
  });

  test('NO_PROXY 命中则不走代理，含括号 IPv6', () => {
    saveEnv();
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    process.env.NO_PROXY = '::1,example.com';
    expect(httpProxyUrlFor(new URL('https://[::1]/x'))).toBeNull();
    expect(httpProxyUrlFor(new URL('https://other.example/'))).toBe('http://127.0.0.1:8080/');
  });

  test('ALL_PROXY 仅为 socks 时返回 null', () => {
    saveEnv();
    clearProxyEnv();
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
    expect(httpProxyUrlFor(new URL('wss://relay.example/relay/uplink'))).toBeNull();
  });

  test('私网字面量即使无 NO_PROXY 也直连', () => {
    saveEnv();
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
    expect(httpProxyUrlFor(new URL('ws://100.64.1.2:39001'))).toBeNull();
    expect(httpProxyUrlFor(new URL('ws://192.168.1.20:39001'))).toBeNull();
    expect(httpProxyUrlFor(new URL('ws://10.0.0.148:39001'))).toBeNull();
    expect(httpProxyUrlFor(new URL('ws://10.20.30.40:39001'))).toBeNull();
    expect(httpProxyUrlFor(new URL('ws://[::1]:39001'))).toBeNull();
    expect(httpProxyUrlFor(new URL('https://relay.example/'))).toBe('http://127.0.0.1:8080/');
  });

  test('socks 日志写实际命中的环境变量名', () => {
    saveEnv();
    clearProxyEnv();
    const prevLevel = process.env.VIBETERM_LOG_LEVEL;
    process.env.VIBETERM_LOG_LEVEL = 'info';
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
      expect(httpProxyUrlFor(new URL('https://relay.example/x'))).toBeNull();
      expect(warnings.some((line) => line.includes('HTTPS_PROXY is socks-only'))).toBe(true);
      expect(warnings.some((line) => line.includes('ALL_PROXY is socks-only'))).toBe(false);

      resetMeshEgressProxyLogForTests();
      warnings.length = 0;
      delete process.env.HTTPS_PROXY;
      process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
      expect(httpProxyUrlFor(new URL('https://relay.example/x'))).toBeNull();
      expect(warnings.some((line) => line.includes('ALL_PROXY is socks-only'))).toBe(true);
    } finally {
      console.warn = orig;
      if (prevLevel === undefined) delete process.env.VIBETERM_LOG_LEVEL;
      else process.env.VIBETERM_LOG_LEVEL = prevLevel;
    }
  });
});

describe('resolveMeshWebSocketProxy', () => {
  test('direct 策略永不带 proxy', () => {
    saveEnv();
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
    setMeshProxyPolicyForTests('direct');
    expect(resolveMeshWebSocketProxy('ws://relay.example/peer')).toBeNull();
  });

  test('system 策略带上 http 代理，socks-only 则直连', () => {
    saveEnv();
    clearProxyEnv();
    process.env.ALL_PROXY = 'socks5://127.0.0.1:1080';
    setMeshProxyPolicyForTests('system');
    expect(resolveMeshWebSocketProxy('wss://relay.example/relay/uplink')).toBeNull();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    expect(resolveMeshWebSocketProxy('wss://relay.example/relay/uplink')).toBe(
      'http://127.0.0.1:8080/'
    );
  });

  test('system 私网对端 WebSocket 不带 proxy', () => {
    saveEnv();
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    setMeshProxyPolicyForTests('system');
    expect(resolveMeshWebSocketProxy('ws://100.64.1.2:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://192.168.1.20:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://10.0.0.148:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://10.20.30.40:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://[::1]:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://[fe80::1]:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://[fd00::1]:39001')).toBeNull();
    expect(resolveMeshWebSocketProxy('ws://relay.example/peer')).toBe('http://127.0.0.1:8080/');
  });

  test('system 私网 WebSocket 假代理 0 次命中', async () => {
    saveEnv();
    const proxyHits: string[] = [];
    const target = Bun.serve({
      hostname: '127.0.0.3',
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response('no-upgrade');
      },
      websocket: {
        open() {},
        message() {},
      },
    });
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        proxyHits.push(`${req.method} ${req.url}`);
        return new Response('from-proxy', { status: 400 });
      },
    });
    let ws: WebSocket | null = null;
    try {
      setProxyEnv(`http://127.0.0.1:${proxy.port}`);
      setMeshProxyPolicyForTests('system');
      ws = meshWebSocket(`ws://127.0.0.3:${target.port}/`);
      await waitWsOpen(ws);
      expect(proxyHits).toEqual([]);
    } finally {
      ws?.close();
      target.stop(true);
      proxy.stop(true);
    }
  });
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

function waitWsOpen(ws: WebSocket, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), ms);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      },
      { once: true }
    );
  });
}
