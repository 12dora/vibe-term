import { afterEach, describe, expect, test } from 'bun:test';
import {
  getMeshNodesState,
  resetMeshNodesStateForTest,
  setMeshNodesStateForTest,
} from '@/node/mesh-nodes';
import { ApiClient } from '@tmex/api-client';
import { AuthApi, type MeshNode } from '@tmex/api-client/auth/index';
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
  ensureNodeLogin,
  getSessionKey,
  hasSessionKey,
  readSessionSecrets,
  replaceSessionKey,
  resetNodeLoginsForTest,
  setLoginLoaderForTest,
} from './session-key-store';
import {
  establishSessionFromPasskey,
  establishSessionFromSeed,
  loginSelf,
  loginToNode,
  resumeSessionAfterPasswordChange,
  selectPasskeyCredential,
} from './session-login';

const UID = 'alice';
/** node id 一律是规范的 32 位小写 hex（`assertNodeId` 只接受这种形态）。 */
const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
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
  /** 非 200 时返回的业务码（缺省 BAD_SIGNATURE）。 */
  loginErrorCode?: string;
  /** `/api/mesh/nodes` 失败（entry 已登录但列表拉不到）。 */
  meshListStatus?: number;
  /** entry 自身在 mesh 列表里的公钥（默认与 challenge 返回的一致）。 */
  entryPkInList?: Uint8Array;
  /** 让匹配的请求直接网络失败。 */
  offline?: (url: string) => boolean;
}): { api: AuthApi; captured: Captured } {
  const nodes = options.nodes ?? [{ id: NODE_A, publicKey: NODE_A_PK }];
  const captured: Captured = { loginCalls: [], challengeCalls: [], meshListCalls: 0 };

  const client = new ApiClient('', (url, init) => {
    if (options.offline?.(url)) return Promise.reject(new Error('offline'));
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
      return Promise.resolve(
        Response.json({ code: options.loginErrorCode ?? 'BAD_SIGNATURE' }, { status })
      );
    }
    // B2-2b 契约：登录成功体只有 expires_at，没有 sid。
    return Promise.resolve(Response.json({ expires_at: 1 }));
  });

  return { api: new AuthApi(client), captured };
}

function meshRow(id: string, publicKey: Uint8Array): MeshNode {
  return {
    id,
    name: id,
    publicKey: encodeBase64url(publicKey),
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
  };
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
  resetNodeLoginsForTest();
  resetMeshNodesStateForTest();
  setLoginLoaderForTest();
});

describe('establishSessionFromSeed', () => {
  test('派生 delegation 并清零传入的 seed', async () => {
    const seed = new Uint8Array(ROOT_SEED);
    const info = await establishSessionFromSeed(seed, {
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

  test('clearSessionKey 之后读不到会话钥', async () => {
    await establishRoot();
    clearSessionKey();
    expect(getSessionKey()).toBeNull();
  });

  test('会话钥生成失败：seed 照样清零，不留下任何会话', async () => {
    const seed = new Uint8Array(ROOT_SEED);
    await expect(
      establishSessionFromSeed(seed, {
        uid: UID,
        entryNodeId: ENTRY,
        rootEpoch: 0,
        hasTotp: false,
        generateSessionKeyPair: () => {
          throw new Error('no ed25519 here');
        },
      })
    ).rejects.toThrow('no ed25519 here');
    expect(seed.every((byte) => byte === 0)).toBe(true);
    expect(getSessionKey()).toBeNull();
  });

  test('createDelegation 抛（sess_pk 长度不对）：seed 与 sk_sess 都清零', async () => {
    const seed = new Uint8Array(ROOT_SEED);
    const secretKey = fill(32, 0x31);
    await expect(
      establishSessionFromSeed(seed, {
        uid: UID,
        entryNodeId: ENTRY,
        rootEpoch: 0,
        hasTotp: false,
        generateSessionKeyPair: () => ({ publicKey: fill(8, 0x32), secretKey }),
      })
    ).rejects.toThrow('sessPk must be 32 bytes');
    expect(seed.every((byte) => byte === 0)).toBe(true);
    expect(secretKey.every((byte) => byte === 0)).toBe(true);
    expect(getSessionKey()).toBeNull();
  });

  test('k_totp 的 HKDF 抛：seed 与 sk_sess 清零，手上那份旧会话不受影响', async () => {
    await establishRoot();
    const oldIssuedAt = getSessionKey()?.issuedAt as number;
    const seed = new Uint8Array(ROOT_SEED);
    const secretKey = fill(32, 0x41);

    await expect(
      establishSessionFromSeed(seed, {
        uid: UID,
        entryNodeId: ENTRY,
        rootEpoch: 0,
        hasTotp: true,
        generateSessionKeyPair: () => ({ publicKey: fill(32, 0x42), secretKey }),
        deriveKTotp: () => {
          throw new Error('hkdf failed');
        },
      })
    ).rejects.toThrow('hkdf failed');
    expect(seed.every((byte) => byte === 0)).toBe(true);
    expect(secretKey.every((byte) => byte === 0)).toBe(true);
    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt);
  });
});

describe('replaceSessionKey（两阶段会话替换）', () => {
  test('新会话被接受：旧会话材料清零，内存里留下新的那一份', async () => {
    await establishRoot();
    const previous = readSessionSecrets();
    const oldSig = previous?.delegationSig as Uint8Array;
    const oldIssuedAt = previous?.info.issuedAt as number;

    const info = await replaceSessionKey(
      async () => {
        await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
          uid: UID,
          entryNodeId: ENTRY,
          rootEpoch: 1,
          hasTotp: false,
          now: oldIssuedAt + 1000,
        });
        return { ok: true } as const;
      },
      (result) => result.ok
    );

    expect(info.ok).toBe(true);
    expect(oldSig.every((byte) => byte === 0)).toBe(true);
    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt + 1000);
  });

  test('新会话被拒：旧会话原样装回，新的那一份被清零', async () => {
    await establishRoot();
    const previous = readSessionSecrets();
    const oldSig = previous?.delegationSig as Uint8Array;
    const oldIssuedAt = previous?.info.issuedAt as number;
    let newSig: Uint8Array | null = null;

    const outcome = await replaceSessionKey(
      async () => {
        await establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
          uid: UID,
          entryNodeId: ENTRY,
          rootEpoch: 1,
          hasTotp: false,
          now: oldIssuedAt + 1000,
        });
        newSig = readSessionSecrets()?.delegationSig ?? null;
        return { ok: false, code: 'NETWORK_ERROR' } as const;
      },
      (result) => result.ok
    );

    expect(outcome.ok).toBe(false);
    // 服务端没有撤销旧会话，页面不该因为一次新登录没打通就掉线。
    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt);
    expect(readSessionSecrets()?.delegationSig).toBe(oldSig);
    expect(oldSig.every((byte) => byte === 0)).toBe(false);
    expect((newSig as unknown as Uint8Array).every((byte) => byte === 0)).toBe(true);
  });

  test('run 抛异常也把旧会话装回，异常照常抛出', async () => {
    await establishRoot();
    const oldIssuedAt = getSessionKey()?.issuedAt;

    await expect(
      replaceSessionKey(async () => {
        throw new Error('argon2 out of memory');
      }, Boolean)
    ).rejects.toThrow('argon2 out of memory');

    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt as number);
  });

  test('替换期间读不到会话钥（调用方必须提前取好 entryNodeId）', async () => {
    await establishRoot();
    let during: unknown = 'unset';
    await replaceSessionKey(
      async () => {
        during = getSessionKey();
        return { ok: false } as const;
      },
      () => false
    );
    expect(during).toBeNull();
    expect(hasSessionKey()).toBe(true);
  });
});

describe('resumeSessionAfterPasswordChange', () => {
  const NEW_KDF = {
    salt: encodeBase64url(fill(16, 0x05)),
    memory_kib: 64,
    iterations: 1,
    parallelism: 1,
  };

  test('登录成功后换成新会话（新 delegation 由新根钥签）', async () => {
    await establishRoot();
    const oldIssuedAt = getSessionKey()?.issuedAt as number;
    const { api, captured } = mockApi({});

    const result = await resumeSessionAfterPasswordChange({
      api,
      uid: UID,
      password: 'new-secret',
      kdfParams: {
        salt: encodeBase64url(fill(16, 0x05)),
        memory_kib: 64,
        iterations: 1,
        parallelism: 1,
      },
      entryNodeId: ENTRY,
      rootEpoch: 1,
      hasTotp: false,
    });

    expect(result).toEqual({ ok: true });
    expect(captured.loginCalls.map((row) => row.nodeId)).toEqual(['self']);
    expect(getSessionKey()?.issuedAt).not.toBe(oldIssuedAt);
  }, 20000);

  test('开了 TOTP 且当场给了码：新会话带着 totp 字段登录成功', async () => {
    await establishRoot({ hasTotp: true, totpCode: '111111' });
    const { api, captured } = mockApi({});

    const result = await resumeSessionAfterPasswordChange({
      api,
      uid: UID,
      password: 'new-secret',
      kdfParams: NEW_KDF,
      entryNodeId: ENTRY,
      rootEpoch: 1,
      hasTotp: true,
      totpCode: '123456',
    });

    expect(result).toEqual({ ok: true });
    const totp = (captured.loginCalls[0].body as { totp?: { code: string; k_totp: string } }).totp;
    expect(totp?.code).toBe('123456');
    expect(decodeBase64url(totp?.k_totp ?? '')).toHaveLength(32);
    expect(getSessionKey()?.hasTotp).toBe(true);
  }, 20000);

  test('验证码不对：node 拒绝这次登录，手上那份旧会话原样留着', async () => {
    await establishRoot({ hasTotp: true, totpCode: '111111' });
    const oldIssuedAt = getSessionKey()?.issuedAt as number;
    const { api } = mockApi({ loginStatus: () => 401, loginErrorCode: 'TOTP_INVALID' });

    const result = await resumeSessionAfterPasswordChange({
      api,
      uid: UID,
      password: 'new-secret',
      kdfParams: NEW_KDF,
      entryNodeId: ENTRY,
      rootEpoch: 1,
      hasTotp: true,
      totpCode: '000000',
    });

    expect(result).toEqual({ ok: false, code: 'TOTP_INVALID' });
    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt);
    expect(getSessionKey()?.hasTotp).toBe(true);
  }, 20000);

  test('开了 TOTP 却没给码：TOTP_REQUIRED，一个请求都不发，旧会话不动', async () => {
    await establishRoot({ hasTotp: true, totpCode: '111111' });
    const oldIssuedAt = getSessionKey()?.issuedAt as number;
    const { api, captured } = mockApi({});

    const result = await resumeSessionAfterPasswordChange({
      api,
      uid: UID,
      password: 'new-secret',
      kdfParams: NEW_KDF,
      entryNodeId: ENTRY,
      rootEpoch: 1,
      hasTotp: true,
    });

    expect(result).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
    expect(captured.challengeCalls).toHaveLength(0);
    expect(captured.loginCalls).toHaveLength(0);
    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt);
  }, 20000);

  test('entry 公钥被掉包：整次替换作废，旧会话也不留下', async () => {
    await establishRoot();
    const { api } = mockApi({ entryPkInList: fill(32, 0x77) });

    const result = await resumeSessionAfterPasswordChange({
      api,
      uid: UID,
      password: 'new-secret',
      kdfParams: NEW_KDF,
      entryNodeId: ENTRY,
      rootEpoch: 1,
      hasTotp: false,
    });

    // 出示的不是被签发过的那把钥：宁可退回登录页，也不让用户带着不可信的会话继续。
    expect(result).toEqual({ ok: false, code: 'NODE_PK_MISMATCH' });
    expect(getSessionKey()).toBeNull();
  }, 20000);

  test('重新登录失败时旧会话仍在，用户不被踢回登录页', async () => {
    await establishRoot();
    const oldIssuedAt = getSessionKey()?.issuedAt as number;
    const { api } = mockApi({ loginStatus: () => 401 });

    const result = await resumeSessionAfterPasswordChange({
      api,
      uid: UID,
      password: 'new-secret',
      kdfParams: {
        salt: encodeBase64url(fill(16, 0x05)),
        memory_kib: 64,
        iterations: 1,
        parallelism: 1,
      },
      entryNodeId: ENTRY,
      rootEpoch: 1,
      hasTotp: false,
    });

    expect(result).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(getSessionKey()?.issuedAt).toBe(oldIssuedAt);
  }, 20000);
});

describe('loginToNode', () => {
  test('登录签名可被共享验签器验证，delegation 由根钥签发', async () => {
    await establishRoot();
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
    await establishRoot();
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
    await establishRoot();
    const { api } = mockApi({});
    expect(await loginToNode(NODE_UNKNOWN, { api })).toEqual({ ok: false, code: 'UNKNOWN_NODE' });
  });

  test('列表 / challenge / login 任一网络失败都映射成 NETWORK_ERROR', async () => {
    await establishRoot();
    const offline = { ok: false, code: 'NETWORK_ERROR' };
    for (const match of [
      (url: string) => url === '/api/mesh/nodes',
      (url: string) => url.endsWith('/challenge'),
      (url: string) => url.endsWith('/login'),
    ]) {
      expect(await loginToNode(NODE_A, { api: mockApi({ offline: match }).api })).toEqual(offline);
    }
  });

  test('后端返回的 code 原样透出', async () => {
    await establishRoot();
    const { api } = mockApi({ loginStatus: () => 401 });
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
});

describe('TOTP 只在 method=root 且用户开了 TOTP 时下发', () => {
  test('root + 已开 TOTP + 有验证码 → 带 totp 字段', async () => {
    await establishRoot({ hasTotp: true, totpCode: '123456' });
    const { api, captured } = mockApi({});
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: true });
    const totp = (captured.login as { totp?: { code: string; k_totp: string } }).totp;
    expect(totp?.code).toBe('123456');
    expect(decodeBase64url(totp?.k_totp ?? '')).toHaveLength(32);
  });

  test('未开 TOTP → 不带 totp 字段', async () => {
    await establishRoot();
    const { api, captured } = mockApi({});
    await loginToNode(NODE_A, { api });
    expect((captured.login as { totp?: unknown }).totp).toBeUndefined();
  });

  test('已开 TOTP 但没有验证码 → TOTP_REQUIRED，且不发请求', async () => {
    await establishRoot({ hasTotp: true });
    const { api, captured } = mockApi({});
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
    expect(captured.challengeCalls).toHaveLength(0);
  });
});

describe('loginSelf', () => {
  test('只登录 self，随后拉一次 mesh 列表核对本机公钥——不再对其余 node fan-out', async () => {
    await establishRoot();
    const { api, captured } = mockApi({
      nodes: [
        { id: NODE_A, publicKey: NODE_A_PK },
        { id: NODE_B, publicKey: NODE_B_PK },
      ],
    });

    expect(await loginSelf({ api })).toEqual({ ok: true });
    expect(captured.loginCalls.map((row) => row.nodeId)).toEqual(['self']);
    expect(captured.challengeCalls).toEqual(['self']);
    expect(captured.meshListCalls).toBe(1);
  });

  test('self 登录失败时原样返回后端的码，且不拉 mesh 列表', async () => {
    await establishRoot();
    const { api, captured } = mockApi({ loginStatus: () => 401 });
    expect(await loginSelf({ api })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(captured.meshListCalls).toBe(0);
  });

  test('mesh 列表拉不到 → NODE_LIST_FAILED（不能当成登录完成）', async () => {
    await establishRoot();
    const { api } = mockApi({ meshListStatus: 500 });
    expect(await loginSelf({ api })).toEqual({ ok: false, code: 'NODE_LIST_FAILED' });
  });

  test('entry 公钥被掉包时清掉会话钥并报 NODE_PK_MISMATCH', async () => {
    await establishRoot();
    const { api } = mockApi({ entryPkInList: fill(32, 0x77) });
    expect(await loginSelf({ api })).toEqual({ ok: false, code: 'NODE_PK_MISMATCH' });
    expect(getSessionKey()).toBeNull();
  });

  test('一次性 TOTP 码用完即清：后续按需登录只能回登录页重新输码', async () => {
    await establishRoot({ hasTotp: true, totpCode: '654321' });
    const { api } = mockApi({});
    expect(await loginSelf({ api })).toEqual({ ok: true });
    expect(await loginToNode(NODE_A, { api })).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
  });

  test('成功后把 mesh store 里 entry 那一行标成已登录', async () => {
    await establishRoot();
    setMeshNodesStateForTest({
      entryNodeId: ENTRY,
      nodes: [meshRow(ENTRY, ENTRY_PK), meshRow(NODE_A, NODE_A_PK)],
    });
    const { api } = mockApi({});
    await loginSelf({ api });
    expect(getMeshNodesState().nodes.find((node) => node.id === ENTRY)?.loggedIn).toBe(true);
    expect(getMeshNodesState().nodes.find((node) => node.id === NODE_A)?.loggedIn).toBe(false);
  });
});

describe('ensureNodeLogin', () => {
  test('并发调用共享同一次登录请求（单飞）', async () => {
    await establishRoot();
    const { api, captured } = mockApi({ nodes: [{ id: NODE_A, publicKey: NODE_A_PK }] });
    const [first, second] = await Promise.all([
      ensureNodeLogin(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) }),
      ensureNodeLogin(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) }),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(captured.loginCalls).toHaveLength(1);
  });

  test('成功后把该 node 在 mesh store 里标成已登录', async () => {
    await establishRoot();
    setMeshNodesStateForTest({
      entryNodeId: ENTRY,
      nodes: [meshRow(ENTRY, ENTRY_PK), meshRow(NODE_A, NODE_A_PK)],
    });
    const { api } = mockApi({ nodes: [{ id: NODE_A, publicKey: NODE_A_PK }] });
    expect(await ensureNodeLogin(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) })).toEqual({
      ok: true,
    });
    expect(getMeshNodesState().nodes.find((node) => node.id === NODE_A)?.loggedIn).toBe(true);
  });

  test('失败不标已登录，并把码交给调用方', async () => {
    await establishRoot();
    setMeshNodesStateForTest({ entryNodeId: ENTRY, nodes: [meshRow(NODE_A, NODE_A_PK)] });
    const { api } = mockApi({
      nodes: [{ id: NODE_A, publicKey: NODE_A_PK }],
      loginStatus: () => 401,
    });
    expect(await ensureNodeLogin(NODE_A, { api, node: meshRow(NODE_A, NODE_A_PK) })).toEqual({
      ok: false,
      code: 'BAD_SIGNATURE',
    });
    expect(getMeshNodesState().nodes.find((node) => node.id === NODE_A)?.loggedIn).toBe(false);
  });

  test('会话钥不在内存里时立刻返回 NO_SESSION_KEY，一个请求都不发', async () => {
    clearSessionKey();
    const { api, captured } = mockApi({});
    expect(await ensureNodeLogin(NODE_A, { api })).toEqual({ ok: false, code: 'NO_SESSION_KEY' });
    expect(captured.challengeCalls).toHaveLength(0);
  });

  test('登录 chunk 拉不下来时返回 NETWORK_ERROR，下一次调用重新加载', async () => {
    await establishRoot();
    setMeshNodesStateForTest({ entryNodeId: ENTRY, nodes: [meshRow(NODE_A, NODE_A_PK)] });
    let loads = 0;
    setLoginLoaderForTest(() => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
        : Promise.resolve({ loginToNode: async () => ({ ok: true }) as const });
    });

    expect(await ensureNodeLogin(NODE_A)).toEqual({ ok: false, code: 'NETWORK_ERROR' });
    expect(getMeshNodesState().nodes.find((node) => node.id === NODE_A)?.loggedIn).toBe(false);

    expect(await ensureNodeLogin(NODE_A)).toEqual({ ok: true });
    expect(loads).toBe(2);
    expect(getMeshNodesState().nodes.find((node) => node.id === NODE_A)?.loggedIn).toBe(true);
  });

  test('并发调用只加载一次实现、只登录一次', async () => {
    await establishRoot();
    let loads = 0;
    let logins = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setLoginLoaderForTest(async () => {
      loads += 1;
      await gate;
      return {
        loginToNode: async () => {
          logins += 1;
          return { ok: true } as const;
        },
      };
    });

    const first = ensureNodeLogin(NODE_A);
    const second = ensureNodeLogin(NODE_A);
    expect(second).toBe(first);
    release();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(loads).toBe(1);
    expect(logins).toBe(1);
  });
});

describe('常驻模块的静态依赖', () => {
  test('只动态加载 ./session-login，不静态拖入 argon2 / 椭圆曲线（否则会回到首屏 chunk）', async () => {
    const scan = async (file: string) =>
      new Bun.Transpiler({ loader: file.endsWith('x') ? 'tsx' : 'ts' }).scanImports(
        await Bun.file(`${import.meta.dir}/${file}`).text()
      );
    const store = await scan('session-key-store.ts');
    expect(store.find((entry) => entry.path === './session-login')?.kind).toBe('dynamic-import');
    expect(store.map((entry) => entry.path)).not.toContain('@tmex/shared/auth');

    // 侧边栏 / 路由边界这两条常驻入口也只能碰 store，不能直接引实现。
    for (const file of ['NodeLoginButton.tsx', 'use-node-login.ts']) {
      const paths = (await scan(file)).map((entry) => entry.path);
      expect(paths).not.toContain('./session-login');
      expect(paths).not.toContain('@tmex/shared/auth');
    }
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
    ).toEqual({ kind: 'bind', credentialId: 'cred-b' });
  });

  test('当前 origin 没有可用凭证时返回 none（不拿别的 origin 的凑数）', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A, B],
        passkeys,
        origin: 'https://node-c.example',
      })
    ).toEqual({ kind: 'none' });
  });

  test('rp_id 相同但端口不同（origin 不等）同样不可用', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A],
        passkeys: [
          {
            credential_id: 'cred-a',
            name: 'A',
            rp_id: 'node-a.example',
            origin: 'https://node-a.example:8443',
          },
        ],
        origin: 'https://node-a.example',
      })
    ).toEqual({ kind: 'none' });
  });

  test('拿不到 passkey 元数据（登录前无会话）时信后端的过滤结果', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [B],
        passkeys: null,
        origin: 'https://node-b.example',
      })
    ).toEqual({ kind: 'bind', credentialId: 'cred-b' });
  });

  test('没有元数据且候选不止一把：原样交给浏览器，绝不取第一把', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A, B],
        passkeys: null,
        origin: 'https://node-b.example',
      })
    ).toEqual({ kind: 'browser', allowCredentials: [A, B] });
  });

  test('同一 origin 有多把时也交给浏览器选（只把范围收到该 origin）', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A, B],
        passkeys: [
          { credential_id: 'cred-a', name: 'A', rp_id: 'n.example', origin: 'https://n.example' },
          { credential_id: 'cred-b', name: 'B', rp_id: 'n.example', origin: 'https://n.example' },
        ],
        origin: 'https://n.example',
      })
    ).toEqual({ kind: 'browser', allowCredentials: [A, B] });
  });

  test('显式指定的凭证必须在 allowCredentials 里', () => {
    expect(
      selectPasskeyCredential({
        allowCredentials: [A],
        passkeys,
        origin: 'https://node-a.example',
        preferredId: 'cred-b',
      })
    ).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// passkey 登录：sk_sess 的所有权 + 后端 origin 过滤的 404（B2-8）
// ---------------------------------------------------------------------------

function passkeyApi(options: {
  optionsStatus?: number;
  optionsBody?: unknown;
  allowCredentials?: { id: string }[];
}): { api: AuthApi; calls: number } {
  const state = { calls: 0 };
  const client = new ApiClient('', (url) => {
    if (url === '/api/auth/passkey/login/options') {
      state.calls += 1;
      const status = options.optionsStatus ?? 200;
      if (status !== 200) {
        return Promise.resolve(Response.json(options.optionsBody ?? {}, { status }));
      }
      return Promise.resolve(
        Response.json({
          challenge: encodeBase64url(fill(32, 0x77)),
          rpId: 'node.example',
          allowCredentials: (options.allowCredentials ?? [{ id: 'cred-a' }]).map((row) => ({
            id: row.id,
            type: 'public-key',
          })),
        })
      );
    }
    if (url === '/api/auth/passkeys') {
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  return {
    api: new AuthApi(client),
    get calls() {
      return state.calls;
    },
  };
}

describe('establishSessionFromPasskey', () => {
  afterEach(() => clearSessionKey());

  test('仪式失败（本环境没有 WebAuthn，等价于用户取消）时 sk_sess 立刻清零', async () => {
    const { api } = passkeyApi({});
    const secretKey = fill(64, 0x9a);

    await expect(
      establishSessionFromPasskey({
        uid: UID,
        entryNodeId: ENTRY,
        api,
        origin: 'https://node.example',
        passkeys: null,
        generateSessionKeyPair: () => ({ publicKey: fill(32, 0x9b), secretKey }),
      })
    ).rejects.toThrow();

    expect(secretKey.every((byte) => byte === 0)).toBe(true);
    expect(hasSessionKey()).toBe(false);
  });

  test('本 origin 没有可用 passkey（404 NO_PASSKEY_FOR_ORIGIN）：可判别错误 + 清零，不回退', async () => {
    const { api } = passkeyApi({
      optionsStatus: 404,
      optionsBody: { code: 'NO_PASSKEY_FOR_ORIGIN' },
    });
    const secretKey = fill(64, 0x8a);

    const error = await establishSessionFromPasskey({
      uid: UID,
      entryNodeId: ENTRY,
      api,
      origin: 'https://node.example',
      passkeys: null,
      generateSessionKeyPair: () => ({ publicKey: fill(32, 0x8b), secretKey }),
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect((error as { code?: string })?.code).toBe('NO_PASSKEY_FOR_ORIGIN');
    expect(secretKey.every((byte) => byte === 0)).toBe(true);
    expect(hasSessionKey()).toBe(false);
  });

  test('已知元数据里本 origin 一把都没有：不去做仪式，直接报「本入口没有可用 passkey」', async () => {
    const passkey = passkeyApi({ allowCredentials: [{ id: 'cred-a' }] });
    const { api } = passkey;

    const error = await establishSessionFromPasskey({
      uid: UID,
      entryNodeId: ENTRY,
      api,
      origin: 'https://other.example',
      passkeys: [
        {
          credential_id: 'cred-a',
          name: 'A',
          rp_id: 'node.example',
          origin: 'https://node.example',
        },
      ],
      generateSessionKeyPair: () => ({ publicKey: fill(32, 0x7b), secretKey: fill(64, 0x7a) }),
    }).then(
      () => null,
      (err: unknown) => err
    );

    expect((error as { code?: string })?.code).toBe('PASSKEY_CREDENTIAL_UNKNOWN');
    // 只有那次探测 options：绑定凭证的第二次请求与仪式都不该发生
    expect(passkey.calls).toBe(1);
  });
});
