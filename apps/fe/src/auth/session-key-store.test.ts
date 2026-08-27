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
  selectPasskeyCredential,
} from './session-key-store';

const UID = 'alice';
/** node id 一律是规范的 32 位小写 hex（`assertNodeId` 只接受这种形态）。 */
const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
const NODE_OFF = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const NODE_DONE = '0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d';
const NODE_UNKNOWN = '0909090909090909090909090909090c';

function fill(length: number, value: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(value);
  return out;
}

const ROOT_SEED = fill(32, 0x11);
const ROOT_PUBLIC_KEY = rootKeyFromSeed(ROOT_SEED).publicKey;
const ENTRY_PK = fill(32, 0x55);
const NODE_A_PK = fill(32, 0x22);
const NODE_B_PK = fill(32, 0x33);
const NONCE = fill(32, 0x44);

interface Captured {
  login?: Record<string, unknown>;
  loginCalls: { nodeId: string; body: Record<string, unknown> }[];
  challengeCalls: string[];
  meshListCalls: number;
}

function mockApi(options: {
  nodes?: { id: string; publicKey: Uint8Array; online?: boolean; loggedIn?: boolean }[];
  nodePkOverride?: Record<string, Uint8Array>;
  loginStatus?: (nodeId: string) => number;
  /** `/api/mesh/nodes` 失败（entry 已登录但列表拉不到）。 */
  meshListStatus?: number;
  /** entry 自身在 mesh 列表里的公钥（默认与 challenge 返回的一致）。 */
  entryPkInList?: Uint8Array;
}): { api: AuthApi; captured: Captured } {
  const nodes = options.nodes ?? [{ id: NODE_A, publicKey: NODE_A_PK }];
  const captured: Captured = { loginCalls: [], challengeCalls: [], meshListCalls: 0 };

  const client = new ApiClient('', (url, init) => {
    if (url === '/api/mesh/nodes') {
      captured.meshListCalls += 1;
      if (options.meshListStatus && options.meshListStatus !== 200) {
        return Promise.resolve(new Response('nope', { status: options.meshListStatus }));
      }
      const rows = [
        {
          id: ENTRY,
          name: 'entry',
          publicKey: encodeBase64url(options.entryPkInList ?? ENTRY_PK),
          online: true,
          reach: 'direct',
          version: '0.0.0',
          direct_capable: true,
          loggedIn: true,
        },
        ...nodes.map((node) => ({
          id: node.id,
          name: node.id,
          publicKey: encodeBase64url(node.publicKey),
          online: node.online ?? true,
          reach: 'direct',
          version: '0.0.0',
          direct_capable: true,
          loggedIn: node.loggedIn ?? false,
        })),
      ];
      return Promise.resolve(Response.json({ nodes: rows }));
    }
    // self 路径没有 `/n/<id>` 前缀。
    const selfMatch = /^\/api\/auth\/(challenge|login)$/.exec(url);
    const match = selfMatch ?? /^\/n\/([^/]+)\/api\/auth\/(challenge|login)$/.exec(url);
    if (!match) return Promise.resolve(new Response('not found', { status: 404 }));
    const nodeId = selfMatch ? 'self' : decodeURIComponent(match[1]);
    const kind = selfMatch ? match[1] : match[2];
    if (kind === 'challenge') {
      captured.challengeCalls.push(nodeId);
      const pk =
        options.nodePkOverride?.[nodeId] ??
        (selfMatch ? ENTRY_PK : nodes.find((node) => node.id === nodeId)?.publicKey) ??
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
    // B2-2b 契约：登录成功体只有 expires_at，没有 sid。
    return Promise.resolve(Response.json({ expires_at: 1 }));
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
    const result = await loginToNode(NODE_A, { api });
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
        challengeId: `c-${NODE_A}`,
        nonce: NONCE,
        target: NODE_A,
        targetPk: NODE_A_PK,
        uid: UID,
        entry: ENTRY,
      })
    ).toEqual({ ok: true });
  });

  test('目标公钥与 mesh 列表不一致时中止，不发送 login', async () => {
    establishRoot();
    const { api, captured } = mockApi({ nodePkOverride: { [NODE_A]: fill(32, 0x99) } });
    const result = await loginToNode(NODE_A, { api });
    expect(result).toEqual({ ok: false, code: 'NODE_PK_MISMATCH' });
    expect(captured.loginCalls).toHaveLength(0);
  });

  test('没有会话钥时直接失败', async () => {
    const { api } = mockApi({});
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'NO_SESSION_KEY' });
  });

  test('mesh 列表里没有该 node 时报 UNKNOWN_NODE', async () => {
    establishRoot();
    const { api } = mockApi({});
    expect(await loginToNode(NODE_UNKNOWN, { api })).toEqual({ ok: false, code: 'UNKNOWN_NODE' });
  });

  test('后端返回的 code 原样透出', async () => {
    establishRoot();
    const { api } = mockApi({ loginStatus: () => 401 });
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
});

describe('TOTP 只在 method=root 且用户开了 TOTP 时下发', () => {
  test('root + 已开 TOTP + 有验证码 → 带 totp 字段', async () => {
    establishRoot({ hasTotp: true, totpCode: '123456' });
    const { api, captured } = mockApi({});
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: true });
    const totp = (captured.login as { totp?: { code: string; k_totp: string } }).totp;
    expect(totp?.code).toBe('123456');
    expect(decodeBase64url(totp?.k_totp ?? '')).toHaveLength(32);
  });

  test('未开 TOTP → 不带 totp 字段', async () => {
    establishRoot();
    const { api, captured } = mockApi({});
    await loginToNode(NODE_A, { api });
    expect((captured.login as { totp?: unknown }).totp).toBeUndefined();
  });

  test('已开 TOTP 但没有验证码 → TOTP_REQUIRED，且不发请求', async () => {
    establishRoot({ hasTotp: true });
    const { api, captured } = mockApi({});
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
    expect(captured.challengeCalls).toHaveLength(0);
  });
});

describe('loginToAllReachable', () => {
  test('先登录 self，再用新会话拉 /api/mesh/nodes 并对其余在线 node 并行登录', async () => {
    establishRoot();
    const { api, captured } = mockApi({
      nodes: [
        { id: NODE_A, publicKey: NODE_A_PK },
        { id: NODE_B, publicKey: NODE_B_PK },
        { id: NODE_OFF, publicKey: NODE_A_PK, online: false },
        { id: NODE_DONE, publicKey: NODE_A_PK, loggedIn: true },
      ],
      loginStatus: (nodeId) => (nodeId === NODE_B ? 401 : 200),
    });

    const outcome = await loginToAllReachable({ api });
    expect(outcome.anyOk).toBe(true);
    expect(outcome.listFailed).toBe(false);
    // self 一定排在最前面：它是拿到 `/api/mesh/nodes` 的前提。
    expect(outcome.rows[0]).toMatchObject({ nodeId: 'self', status: 'ok' });
    expect(captured.challengeCalls[0]).toBe('self');
    expect(outcome.rows.map((row) => row.nodeId).sort()).toEqual([NODE_A, NODE_B, 'self'].sort());
    expect(outcome.rows.find((row) => row.nodeId === NODE_A)?.status).toBe('ok');
    expect(outcome.rows.find((row) => row.nodeId === NODE_B)).toMatchObject({
      status: 'error',
      code: 'BAD_SIGNATURE',
    });
  });

  test('self 登录失败时不拉 mesh 列表，anyOk=false', async () => {
    establishRoot();
    const { api, captured } = mockApi({ loginStatus: () => 401 });
    const outcome = await loginToAllReachable({ api });
    expect(outcome.anyOk).toBe(false);
    expect(outcome.listFailed).toBe(false);
    expect(captured.meshListCalls).toBe(0);
  });

  test('mesh 列表拉取失败与「没有其它目标」区分：listFailed=true', async () => {
    establishRoot();
    const { api } = mockApi({ meshListStatus: 500 });
    const outcome = await loginToAllReachable({ api });
    expect(outcome.anyOk).toBe(true);
    expect(outcome.listFailed).toBe(true);
  });

  test('entry 公钥被掉包时清掉会话钥并报 NODE_PK_MISMATCH', async () => {
    establishRoot();
    const { api } = mockApi({ entryPkInList: fill(32, 0x77) });
    const outcome = await loginToAllReachable({ api });
    expect(outcome.anyOk).toBe(false);
    expect(outcome.rows[0]).toMatchObject({ nodeId: 'self', code: 'NODE_PK_MISMATCH' });
    expect(getSessionKey()).toBeNull();
  });

  test('fan-out 结束后一次性 TOTP 码被清掉', async () => {
    establishRoot({ hasTotp: true, totpCode: '654321' });
    const { api } = mockApi({});
    await loginToAllReachable({ api });
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
  });
});

describe('selectPasskeyCredential', () => {
  const A = { id: 'cred-a' };
  const B = { id: 'cred-b' };
  const passkeys = [
    {
      credential_id: 'cred-a',
      name: 'A',
      rp_id: 'node-a.example',
      origin: 'https://node-a.example',
    },
    {
      credential_id: 'cred-b',
      name: 'B',
      rp_id: 'node-b.example',
      origin: 'https://node-b.example',
    },
  ];

  test('按当前 origin 选，而不是列表第一把', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A, B],
        passkeys,
        origin: 'https://node-b.example',
      })
    ).toBe('cred-b');
  });

  test('当前 origin 没有可用凭证时返回 null（不拿别的 origin 的凑数）', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A, B],
        passkeys,
        origin: 'https://node-c.example',
      })
    ).toBeNull();
  });

  test('拿不到 passkey 元数据（登录前无会话）时信后端的过滤结果', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [B],
        passkeys: null,
        origin: 'https://node-b.example',
      })
    ).toBe('cred-b');
  });

  test('显式指定的凭证必须在 allowCredentials 里', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A],
        passkeys,
        origin: 'https://node-a.example',
        preferredId: 'cred-b',
      })
    ).toBeNull();
  });
});
