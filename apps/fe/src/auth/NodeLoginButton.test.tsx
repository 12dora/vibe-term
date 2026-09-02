// 「登录此节点」按钮的登录编排：点按钮是用户主动发起的登录，必须允许当场做通行密钥仪式，
// 否则从旧会话恢复出来、盘上没有断言的用户会陷在「点一次发一个同样的请求」的死循环里。

import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import {
  AuthApi,
  type AuthenticationResponseJSON,
  type MeshNode,
} from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { loginFromNodeButton, needsLoginPage } from './NodeLoginButton';
import {
  clearSessionKey,
  ensureNodeLogin,
  hasSessionKey,
  resetNodeLoginsForTest,
  setLoginLoaderForTest,
} from './session-key-store';
import { establishSessionFromSeed, setPasskeyCeremonyForTest } from './session-login';

const UID = 'alice';
const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const CRED = 'cred-a';

function fill(length: number, value: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(value);
  return out;
}

const ROOT_SEED = fill(32, 0x11);
const NODE_A_PK = fill(32, 0x22);
const NONCE = fill(32, 0x44);

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

function fakeAssertion(): AuthenticationResponseJSON {
  return {
    id: CRED,
    rawId: CRED,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: encodeBase64url(fill(8, 0xc1)),
      authenticatorData: encodeBase64url(fill(8, 0xc2)),
      signature: encodeBase64url(fill(8, 0xc3)),
    },
  };
}

/** 服务端要求二次验证：登录体不带 `passkey` 就回 401 PASSKEY_REQUIRED。 */
function passkeyRequiredApi(): { api: AuthApi; loginBodies: Record<string, unknown>[] } {
  const loginBodies: Record<string, unknown>[] = [];
  const client = new ApiClient('', (url, init) => {
    if (url === '/api/auth/passkey/login/options') {
      return Promise.resolve(
        Response.json({
          challenge: encodeBase64url(fill(32, 0x77)),
          rpId: 'node.example',
          allowCredentials: [{ id: CRED, type: 'public-key' }],
        })
      );
    }
    const match = /^\/n\/([^/]+)\/api\/auth\/(challenge|login)$/.exec(url);
    if (!match) return Promise.resolve(new Response('not found', { status: 404 }));
    if (match[2] === 'challenge') {
      return Promise.resolve(
        Response.json({
          challenge_id: `c-${loginBodies.length}`,
          nonce: encodeBase64url(NONCE),
          nodePk: encodeBase64url(NODE_A_PK),
        })
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    loginBodies.push(body);
    if (!body.passkey) {
      return Promise.resolve(Response.json({ code: 'PASSKEY_REQUIRED' }, { status: 401 }));
    }
    return Promise.resolve(Response.json({ expires_at: 1 }));
  });
  return { api: new AuthApi(client), loginBodies };
}

function establishRoot() {
  return establishSessionFromSeed(new Uint8Array(ROOT_SEED), {
    uid: UID,
    entryNodeId: ENTRY,
    rootEpoch: 0,
    hasTotp: false,
  });
}

afterEach(() => {
  clearSessionKey();
  resetNodeLoginsForTest();
  setLoginLoaderForTest();
  setPasskeyCeremonyForTest();
});

describe('needsLoginPage', () => {
  test('只有需要重新交互的失败才回登录页', () => {
    expect(needsLoginPage('NO_SESSION_KEY')).toBe(true);
    expect(needsLoginPage('TOTP_REQUIRED')).toBe(true);
    expect(needsLoginPage('PASSKEY_REQUIRED')).toBe(true);
  });

  test('取消仪式 / 本地址没凭证 / 网络错误留在原地重试，不跳走', () => {
    expect(needsLoginPage('PASSKEY_ABORTED')).toBe(false);
    expect(needsLoginPage('NO_PASSKEY_FOR_ORIGIN')).toBe(false);
    expect(needsLoginPage('NETWORK_ERROR')).toBe(false);
    expect(needsLoginPage('UNKNOWN_NODE')).toBe(false);
  });
});

describe('loginFromNodeButton', () => {
  test('按钮点击一律带 allowPasskeyPrompt，后台静默登录不带', async () => {
    const seen: (boolean | undefined)[] = [];
    setLoginLoaderForTest(async () => ({
      loginToNode: async (_nodeId, opts) => {
        seen.push(opts.allowPasskeyPrompt);
        return { ok: true } as const;
      },
    }));
    await establishRoot();

    expect(await loginFromNodeButton(NODE_A)).toEqual({ ok: true });
    resetNodeLoginsForTest();
    expect(await ensureNodeLogin(NODE_A)).toEqual({ ok: true });

    expect(seen).toEqual([true, undefined]);
  });

  test('静默登录失败在先、按钮点击在后：仪式这才做得成', async () => {
    await establishRoot();
    const backend = passkeyRequiredApi();
    let ceremonies = 0;
    setPasskeyCeremonyForTest(async () => {
      ceremonies += 1;
      return fakeAssertion();
    });
    const node = meshRow(NODE_A, NODE_A_PK);

    // 门闸的静默登录：不许弹系统仪式，只能把码交回调用方。
    expect(await ensureNodeLogin(NODE_A, { api: backend.api, node })).toEqual({
      ok: false,
      code: 'PASSKEY_REQUIRED',
    });
    expect(ceremonies).toBe(0);
    expect(backend.loginBodies).toHaveLength(1);
    // 会话钥必须留着：少带一次断言不是凭证失效。
    expect(hasSessionKey()).toBe(true);

    // 用户点「登录此节点」：同一条路径，这次允许仪式，补完断言后重试成功。
    expect(
      await ensureNodeLogin(NODE_A, { api: backend.api, node, allowPasskeyPrompt: true })
    ).toEqual({ ok: true });
    expect(ceremonies).toBe(1);
    expect(backend.loginBodies).toHaveLength(3);
    expect(
      (backend.loginBodies[2] as { passkey?: { credential_id: string } }).passkey?.credential_id
    ).toBe(CRED);
  });
});
