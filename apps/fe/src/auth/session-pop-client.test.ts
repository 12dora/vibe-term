import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  ApiClient,
  getRequestPopProvider,
  setRequestPopProvider,
  withPopParam,
} from '@vibeterm/api-client';
import {
  type AuthApi,
  type AuthLoginRequest,
  handleNodeLoginRequired,
} from '@vibeterm/api-client/auth/index';
import {
  generateWebCryptoEd25519KeyPair,
  popTargetFromUrl,
  verifyPop,
} from '@vibeterm/shared/auth';
import { POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { openSignedSocket, setWsUrlSigner } from '@vibeterm/ws-client/socket-pop';
import type { PersistedPopKey } from './session-key-persistence';
import type { SessionKeySecrets } from './session-key-types';
import {
  POP_SESSION_HARD_TTL_MS,
  clearSessionPop,
  installSessionPop,
  loadPopState,
  loginWithPop,
  onPopNodesChange,
  popNodeIds,
  resetSessionPopForTest,
  setPopStorageForTest,
} from './session-pop-client';

const NODE_B = 'b'.repeat(32);
const NODE_C = 'c'.repeat(32);

interface Disk {
  record: PersistedPopKey | null;
  saves: PersistedPopKey[];
  clears: number;
  failSave: boolean;
}

let disk: Disk;
let keyPair: Awaited<ReturnType<typeof generateWebCryptoEd25519KeyPair>>;

function useDisk(): void {
  disk = { record: null, saves: [], clears: 0, failSave: false };
  setPopStorageForTest({
    load: () => Promise.resolve(disk.record),
    save: (record) => {
      if (disk.failSave) return Promise.resolve(false);
      disk.saves.push(record);
      disk.record = record;
      return Promise.resolve(true);
    },
    clear: () => {
      disk.clears += 1;
      disk.record = null;
      return Promise.resolve(true);
    },
  });
}

function secrets(overrides: Partial<SessionKeySecrets> = {}): SessionKeySecrets {
  return {
    sessKey: keyPair.privateKey,
    sessPk: keyPair.publicKey,
    ...overrides,
  } as SessionKeySecrets;
}

function fakeApi(ok = true) {
  const bodies: AuthLoginRequest[] = [];
  const api = {
    login: mock((_nodeId: string, body: AuthLoginRequest) => {
      bodies.push(body);
      return Promise.resolve(ok ? { ok: true, expires_at: 1 } : { ok: false, code: 'BAD' });
    }),
  };
  return { api: api as unknown as AuthApi, bodies };
}

const baseBody = {
  login: 'l',
  sig: 's',
  delegation: 'd',
  delegation_sig: 'ds',
} satisfies AuthLoginRequest;

async function login(nodeId: string, s: SessionKeySecrets = secrets(), ok = true) {
  const { api, bodies } = fakeApi(ok);
  const result = await loginWithPop(api, nodeId, baseBody, s);
  return { result, body: bodies[0] };
}

function signOf(method: string, url: string) {
  const provider = getRequestPopProvider();
  return provider?.sign(method, url) ?? null;
}

const globalWithLocation = globalThis as { location?: { host: string } };
const originalLocation = globalWithLocation.location;

beforeEach(async () => {
  globalWithLocation.location = { host: 'gw.example' };
  keyPair = await generateWebCryptoEd25519KeyPair();
  resetSessionPopForTest();
  useDisk();
  installSessionPop();
});

afterEach(() => {
  globalWithLocation.location = originalLocation;
  resetSessionPopForTest();
  setPopStorageForTest();
  setRequestPopProvider(null);
  setWsUrlSigner(null);
});

describe('登录声明 pop', () => {
  test('不可导出钥且落盘成功：请求体带 pop: true，登录成功后记为 PoP node', async () => {
    const { body } = await login('self');
    expect(body.pop).toBe(true);
    expect(popNodeIds()).toEqual(['self']);
    expect(disk.record?.nodes.self).toBeGreaterThan(Date.now() + POP_SESSION_HARD_TTL_MS - 5_000);
  });

  test('@noble 回退钥（没有 CryptoKey）：不声明、不记录', async () => {
    const { body } = await login('self', secrets({ sessKey: null }));
    expect(body.pop).toBeUndefined();
    expect(popNodeIds()).toEqual([]);
    expect(disk.saves).toHaveLength(0);
  });

  test('钥没能落盘：不声明 pop', async () => {
    disk.failSave = true;
    const { body } = await login('self');
    expect(body.pop).toBeUndefined();
    expect(popNodeIds()).toEqual([]);
  });

  test('登录失败不记 PoP node', async () => {
    const { body } = await login('self', secrets(), false);
    expect(body.pop).toBe(true);
    expect(popNodeIds()).toEqual([]);
  });

  test('同一把钥再登录别的 node：沿用已有集合，不重复落盘钥', async () => {
    await login('self');
    await login(NODE_B);
    expect(popNodeIds().sort()).toEqual(['self', NODE_B].sort());
  });

  test('换了一把钥（重新登录）：旧集合清空重来', async () => {
    await login('self');
    const other = await generateWebCryptoEd25519KeyPair();
    await login(NODE_B, secrets({ sessKey: other.privateKey, sessPk: other.publicKey }));
    expect(popNodeIds()).toEqual([NODE_B]);
  });
});

describe('请求签名', () => {
  test('转发路径按目标节点视角规范化后验签通过，并且逐次 nonce 不同', async () => {
    await login(NODE_B);
    const url = `/n/${NODE_B}/api/files/list?path=%2Ftmp&n=1`;
    const first = await signOf('post', url);
    const second = await signOf('post', url);
    expect(first).not.toBeNull();
    expect(first).not.toBe(second);
    const target = popTargetFromUrl('POST', '/api/files/list?path=%2Ftmp&n=1');
    expect(verifyPop(keyPair.publicKey, first, target).ok).toBe(true);
  });

  test('没有 PoP 会话的 node / 没有钥：同步返回 null，请求原样发出', async () => {
    expect(signOf('GET', '/api/x')).not.toBeNull();
    await loadPopState();
    expect(signOf('GET', '/api/x')).toBeNull();
    await login(NODE_B);
    expect(signOf('GET', '/api/x')).toBeNull();
    expect(signOf('GET', `/n/${NODE_C}/api/x`)).toBeNull();
    expect(signOf('GET', `/n/${NODE_B}/api/x`)).not.toBeNull();
  });

  test('登录仪式端点与外域 URL 不签', async () => {
    await login('self');
    expect(signOf('POST', '/api/auth/login')).toBeNull();
    expect(signOf('POST', '/api/auth/challenge')).toBeNull();
    expect(signOf('GET', 'https://other.example/api/x')).toBeNull();
  });

  test('ApiClient 端到端：每次发送带 x-vibeterm-pop', async () => {
    await login('self');
    const seen: Array<string | null> = [];
    const client = new ApiClient('', (_url, init) => {
      seen.push(new Headers(init?.headers).get(POP_HEADER));
      return Promise.resolve(new Response('ok'));
    });
    await client.fetch('/api/devices');
    await client.fetch('/api/devices', { method: 'POST' });
    expect(seen.every((value) => typeof value === 'string' && value.startsWith('v1.'))).toBe(true);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test('POP_INVALID：钥还在就重签重试一次', async () => {
    await login('self');
    const seen: Array<string | null> = [];
    const replies = [new Response('{"code":"POP_INVALID"}', { status: 401 }), new Response('ok')];
    const client = new ApiClient('', (_url, init) => {
      seen.push(new Headers(init?.headers).get(POP_HEADER));
      return Promise.resolve(replies.shift() as Response);
    });
    const res = await client.fetch('/api/devices', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test('WS 升级 URL：追加 pop 参数，签名目标是去掉 /n 前缀的路径与其余 query', async () => {
    await login(NODE_B);
    const url = `wss://gw.example/n/${NODE_B}/ws?cid=abc`;
    let opened = '';
    const shim = openSignedSocket(url, (target) => {
      opened = target;
      return { readyState: 1 } as never;
    });
    expect(shim.readyState).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const proof = new URL(opened).searchParams.get('pop');
    expect(opened).toBe(withPopParam(url, proof as string));
    const target = popTargetFromUrl('GET', '/ws?cid=abc');
    expect(verifyPop(keyPair.publicKey, proof, target).ok).toBe(true);
  });

  test('WS：没有 PoP 会话的 node 同步直开原 URL', async () => {
    await loadPopState();
    let opened = '';
    openSignedSocket('ws://gw.example/ws?cid=1', (target) => {
      opened = target;
      return { readyState: 0 } as never;
    });
    expect(opened).toBe('ws://gw.example/ws?cid=1');
  });
});

describe('钥的寿命', () => {
  test('冷启动从盘上读回：恢复 PoP node，同一把钥再登录别的 node 不丢旧集合', async () => {
    await login('self');
    const persisted = disk.record as PersistedPopKey;
    resetSessionPopForTest();
    disk.record = { ...persisted, privateKey: keyPair.privateKey };
    await loadPopState();
    expect(popNodeIds()).toEqual(['self']);
    expect(await signOf('GET', '/api/x')).not.toBeNull();

    await login(NODE_B);
    expect(popNodeIds().sort()).toEqual(['self', NODE_B].sort());
  });

  test('读回时已过硬上限的 node 不再签名，全部过期则删盘', async () => {
    disk.record = {
      version: 1,
      privateKey: keyPair.privateKey,
      sessPk: keyPair.publicKey,
      nodes: { self: Date.now() - 1 },
    };
    await loadPopState();
    expect(popNodeIds()).toEqual([]);
    expect(signOf('GET', '/api/x')).toBeNull();
    expect(disk.clears).toBe(1);
  });

  test('钥保留到最晚的 node 会话硬过期，与 delegation 的 18 小时无关', async () => {
    await login('self');
    const expiresAt = disk.record?.nodes.self as number;
    expect(expiresAt - Date.now()).toBeGreaterThan(18 * 3_600_000);
  });

  test('登出：内存立即清零，盘上删除，之后不再签名', async () => {
    await login('self');
    const cleared = await clearSessionPop();
    expect(cleared).toBe(true);
    expect(disk.record).toBeNull();
    expect(popNodeIds()).toEqual([]);
    expect(signOf('GET', '/api/x')).toBeNull();
  });

  test('某个 node 需要重新登录：只摘掉它；最后一个也没了就连钥一起删', async () => {
    await login('self');
    await login(NODE_B);
    handleNodeLoginRequired(NODE_B);
    expect(popNodeIds()).toEqual(['self']);
    expect(disk.clears).toBe(0);
    handleNodeLoginRequired('self');
    expect(popNodeIds()).toEqual([]);
    expect(disk.clears).toBe(1);
  });

  test('canSign：被摘掉的 node 与没有钥一样返回 false，会话拦截器据此走重新登录', async () => {
    await login('self');
    await login(NODE_B);
    const provider = getRequestPopProvider();
    expect(provider?.canSign(`/n/${NODE_B}/api/x`)).toBe(true);
    handleNodeLoginRequired(NODE_B);
    expect(provider?.canSign(`/n/${NODE_B}/api/x`)).toBe(false);
  });

  test('登录成功会通知订阅方并等它完成（导航凭证在登录返回前已换发）', async () => {
    const order: string[] = [];
    const off = onPopNodesChange(async (added) => {
      if (added === null) return;
      await Promise.resolve();
      order.push(`refreshed:${added}`);
    });
    await login('self');
    order.push('login-returned');
    off();
    expect(order).toEqual(['refreshed:self', 'login-returned']);
  });
});
