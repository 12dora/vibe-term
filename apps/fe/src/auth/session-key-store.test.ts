import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { AuthApi } from '@tmex/api-client/auth/index';
import {
  decodeBase64url,
  decodeDelegation,
  decodeLogin,
  encodeBase64url,
  rootKeyFromSeed,
  verifyDelegation,
  verifyLogin,
} from '@tmex/shared/auth';
import {
  clearSessionKey,
  establishSessionFromSeed,
  getSessionKey,
  hasSessionKey,
  loginToAllReachable,
  loginToNode,
} from './session-key-store';

const UID = 'alice';
const ENTRY = 'entry-1';

function fill(length: number, value: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(value);
  return out;
}

const ROOT_SEED = fill(32, 0x11);
const ROOT_PUBLIC_KEY = rootKeyFromSeed(ROOT_SEED).publicKey;
const NODE_A_PK = fill(32, 0x22);
const NODE_B_PK = fill(32, 0x33);
const NONCE = fill(32, 0x44);

interface Captured {
  login?: Record<string, unknown>;
  loginCalls: { nodeId: string; body: Record<string, unknown> }[];
  challengeCalls: string[];
}

function mockApi(options: {
  nodes?: { id: string; publicKey: Uint8Array; online?: boolean; loggedIn?: boolean }[];
  nodePkOverride?: Record<string, Uint8Array>;
  loginStatus?: (nodeId: string) => number;
}): { api: AuthApi; captured: Captured } {
  const nodes = options.nodes ?? [{ id: 'node-a', publicKey: NODE_A_PK }];
  const captured: Captured = { loginCalls: [], challengeCalls: [] };

  const client = new ApiClient('', (url, init) => {
    if (url === '/api/mesh/nodes') {
      return Promise.resolve(
        Response.json({
          nodes: nodes.map((node) => ({
            id: node.id,
            name: node.id,
            publicKey: encodeBase64url(node.publicKey),
            online: node.online ?? true,
            reach: 'direct',
            version: '0.0.0',
            direct_capable: true,
            loggedIn: node.loggedIn ?? false,
          })),
        })
      );
    }
    const match = /^\/n\/([^/]+)\/api\/auth\/(challenge|login)$/.exec(url);
    if (!match) return Promise.resolve(new Response('not found', { status: 404 }));
    const nodeId = decodeURIComponent(match[1]);
    if (match[2] === 'challenge') {
      captured.challengeCalls.push(nodeId);
      const pk =
        options.nodePkOverride?.[nodeId] ??
        nodes.find((node) => node.id === nodeId)?.publicKey ??
        NODE_A_PK;
      return Promise.resolve(
        Response.json({
          challenge_id: `c-${nodeId}`,
          nonce: encodeBase64url(NONCE),
          nodePk: encodeBase64url(pk),
        })
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.loginCalls.push({ nodeId, body });
    captured.login = body;
    const status = options.loginStatus?.(nodeId) ?? 200;
    if (status !== 200) {
      return Promise.resolve(Response.json({ code: 'BAD_SIGNATURE' }, { status }));
    }
    return Promise.resolve(Response.json({ sid: `sid-${nodeId}`, expires_at: 1 }));
  });

  return { api: new AuthApi(client), captured };
}

function establishRoot(opts: { hasTotp?: boolean; totpCode?: string } = {}) {
  return establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
    uid: UID,
    entryNodeId: ENTRY,
    rootEpoch: 0,
    hasTotp: opts.hasTotp ?? false,
    totpCode: opts.totpCode,
  });
}

afterEach(() => {
  clearSessionKey();
});

describe('establishSessionFromSeed', () => {
  test('派生 delegation 并清零传入的 seed', () => {
    const seed = new Uint8Array(ROOT_SEED);
    const info = establishSessionFromSeed(seed, {
      uid: UID,
      entryNodeId: ENTRY,
      rootEpoch: 0,
      hasTotp: false,
    });
    expect(seed.every((byte) => byte === 0)).toBe(true);
    expect(info.method).toBe('root');
    expect(info.uid).toBe(UID);
    expect(info.expiresAt - info.issuedAt).toBe(18 * 60 * 60 * 1000);
    expect(hasSessionKey()).toBe(true);
  });

  test('clearSessionKey 之后读不到会话钥', () => {
    establishRoot();
    clearSessionKey();
    expect(getSessionKey()).toBeNull();
  });
});

describe('loginToNode', () => {
  test('登录签名可被共享验签器验证，delegation 由根钥签发', async () => {
    establishRoot();
    const { api, captured } = mockApi({});
    const result = await loginToNode('node-a', { api });
    expect(result).toEqual({ ok: true });

    const body = captured.login as Record<string, string>;
    const delegation = decodeDelegation(decodeBase64url(body.delegation));
    expect(
      verifyDelegation(delegation, decodeBase64url(body.delegation_sig), {
        rootPublicKey: ROOT_PUBLIC_KEY,
        now: Date.now(),
      }).ok
    ).toBe(true);

    const login = decodeLogin(decodeBase64url(body.login));
    expect(
      verifyLogin(login, decodeBase64url(body.sig), delegation.sess_pk, {
        challengeId: 'c-node-a',
        nonce: NONCE,
        target: 'node-a',
        targetPk: NODE_A_PK,
        uid: UID,
        entry: ENTRY,
      })
    ).toEqual({ ok: true });
  });

  test('目标公钥与 mesh 列表不一致时中止，不发送 login', async () => {
    establishRoot();
    const { api, captured } = mockApi({ nodePkOverride: { 'node-a': fill(32, 0x99) } });
    const result = await loginToNode('node-a', { api });
    expect(result).toEqual({ ok: false, code: 'NODE_PK_MISMATCH' });
    expect(captured.loginCalls).toHaveLength(0);
  });

  test('没有会话钥时直接失败', async () => {
    const { api } = mockApi({});
    expect(await loginToNode('node-a', { api })).toEqual({ ok: false, code: 'NO_SESSION_KEY' });
  });

  test('mesh 列表里没有该 node 时报 UNKNOWN_NODE', async () => {
    establishRoot();
    const { api } = mockApi({});
    expect(await loginToNode('node-zzz', { api })).toEqual({ ok: false, code: 'UNKNOWN_NODE' });
  });

  test('后端返回的 code 原样透出', async () => {
    establishRoot();
    const { api } = mockApi({ loginStatus: () => 401 });
    expect(await loginToNode('node-a', { api })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
});

describe('TOTP 只在 method=root 且用户开了 TOTP 时下发', () => {
  test('root + 已开 TOTP + 有验证码 → 带 totp 字段', async () => {
    establishRoot({ hasTotp: true, totpCode: '123456' });
    const { api, captured } = mockApi({});
    expect(await loginToNode('node-a', { api })).toEqual({ ok: true });
    const totp = (captured.login as { totp?: { code: string; k_totp: string } }).totp;
    expect(totp?.code).toBe('123456');
    expect(decodeBase64url(totp?.k_totp ?? '')).toHaveLength(32);
  });

  test('未开 TOTP → 不带 totp 字段', async () => {
    establishRoot();
    const { api, captured } = mockApi({});
    await loginToNode('node-a', { api });
    expect((captured.login as { totp?: unknown }).totp).toBeUndefined();
  });

  test('已开 TOTP 但没有验证码 → TOTP_REQUIRED，且不发请求', async () => {
    establishRoot({ hasTotp: true });
    const { api, captured } = mockApi({});
    expect(await loginToNode('node-a', { api })).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
    expect(captured.challengeCalls).toHaveLength(0);
  });
});

describe('loginToAllReachable', () => {
  test('对在线且未登录的 node 并行登录，逐个记录进度', async () => {
    establishRoot();
    const { api, captured } = mockApi({
      nodes: [
        { id: 'node-a', publicKey: NODE_A_PK },
        { id: 'node-b', publicKey: NODE_B_PK },
        { id: 'node-off', publicKey: NODE_A_PK, online: false },
        { id: 'node-done', publicKey: NODE_A_PK, loggedIn: true },
      ],
      loginStatus: (nodeId) => (nodeId === 'node-b' ? 401 : 200),
    });

    const rows = await loginToAllReachable({ api });
    expect(rows.map((row) => row.nodeId).sort()).toEqual(['node-a', 'node-b']);
    expect(rows.find((row) => row.nodeId === 'node-a')?.status).toBe('ok');
    expect(rows.find((row) => row.nodeId === 'node-b')).toMatchObject({
      status: 'error',
      code: 'BAD_SIGNATURE',
    });
    expect(captured.challengeCalls.sort()).toEqual(['node-a', 'node-b']);
  });

  test('fan-out 结束后一次性 TOTP 码被清掉', async () => {
    establishRoot({ hasTotp: true, totpCode: '654321' });
    const { api } = mockApi({});
    await loginToAllReachable({ api });
    expect(await loginToNode('node-a', { api })).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
  });
});
