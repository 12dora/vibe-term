// 通行密钥二次验证按 origin 生效的 HTTP 契约（背景见 docs/security/login-security.md）。
// 断言只能在注册它的 origin 完成，所以「另一个入口域名」必须能只凭密码（+ TOTP）登录。
// 本 origin 有钥匙时，有效 TOTP 或断言满足其一即可（CLI 做不了 WebAuthn）。

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeSetTotpPayload,
  encryptTotpSecret,
  sha256,
  totpCode,
} from '@vibeterm/shared/auth';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { setSiteSettingsLinkProvider } from '../api/site-settings-link';
import { encodePasskeyAssertionSig, verifyRegistration } from '../auth/passkey';
import { createEs256Authenticator } from '../auth/passkey-test-fixtures';
import { kdfParamsFromJson } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import { getDb } from '../db/client';
import { getSiteSettings, updateSiteSettings } from '../db/site-settings';
import {
  canonicalOrigin,
  gatePasskeySecondFactor,
  isKnownEntryOrigin,
  passkeyOriginScope,
  resolveSecondFactors,
  sameCanonicalOrigin,
  verifySecondFactors,
} from './auth-passkey-origin';
import { PASSWORD, bootMesh, call, challengeAndLogin } from './auth-routes.test';

const ORIGIN_A = 'https://relay.example';
/** 服务端认得的另一个入口（下面用站点 URL 声明成本实例的对外地址）。 */
const ORIGIN_B = 'https://tunnel.example';
/** 服务端配置里没有的地址：伪造 Origin 就长这样。 */
const ORIGIN_FORGED = 'https://attacker.example';

/**
 * 把某个地址声明成本实例的站点 URL（装配层在生产里做同样的事）。
 * 返回复原函数：这个 provider 是模块级单例，泄漏到别的用例会改变它们的判定。
 */
function declareSiteUrl(url: string | null): () => void {
  setSiteSettingsLinkProvider(
    url
      ? {
          effectiveSiteUrl: () => url,
          localNodeId: () => null,
          linked: () => true,
        }
      : null
  );
  return () => setSiteSettingsLinkProvider(null);
}

type Mesh = Awaited<ReturnType<typeof bootMesh>>;

async function enrollPasskeyAt(userStore: UserStore, userId: string, origin: string) {
  const rpId = new URL(origin).hostname;
  const authenticator = await createEs256Authenticator({
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const challenge = new Uint8Array(32).fill(5);
  const registration = await authenticator.register({ challenge, rpId, origin, counter: 0 });
  const payload = await verifyRegistration({
    response: registration,
    expectedChallenge: encodeBase64url(challenge),
    origin,
    rpId,
  });
  if (!payload) throw new Error('registration failed');
  userStore.insertKey({
    id: crypto.randomUUID(),
    userId,
    credentialId: authenticator.credentialId,
    publicKey: payload.public_key,
    rpId: payload.rp_id,
    origin: payload.origin,
    counter: payload.counter,
    transports: payload.transports,
    name: 'origin-a',
    logSeq: 1,
    now: Date.now(),
  });
  return { authenticator, payload, origin, rpId };
}

type Enrolled = Awaited<ReturnType<typeof enrollPasskeyAt>>;

function assertionFor(enrolled: Enrolled, counter: number) {
  return async (del: { bytes: Uint8Array }) => {
    const assertion = await enrolled.authenticator.assert({
      challenge: sha256(del.bytes),
      rpId: enrolled.rpId,
      origin: enrolled.origin,
      counter,
    });
    return {
      credential_id: enrolled.payload.credential_id,
      sig: encodeBase64url(encodePasskeyAssertionSig(assertion)),
    };
  };
}

/** 给主用户开 TOTP，返回登录体要带的那组字段。 */
async function enableTotp(mesh: Mesh) {
  const state = mesh.keyLogService.currentState(mesh.boot.userId);
  const secret = new Uint8Array(20).fill(9);
  const user = mesh.userStore.getById(mesh.boot.userId);
  if (!user) throw new Error('missing user');
  const seed = await deriveSeed(PASSWORD, kdfParamsFromJson(user.kdfParamsJson));
  const kTotp = deriveTotpKey(seed, mesh.boot.userId, state.rootEpoch);
  const payload = await encryptTotpSecret(kTotp, secret, {
    uid: mesh.boot.userId,
    root_epoch: state.rootEpoch,
    seq: state.head.seq + 1n,
  });
  const applied = await mesh.keyLogService.signAndApply(mesh.boot.userId, mesh.boot.rootKey, {
    type: 'set-totp',
    payload: encodeSetTotpPayload(payload),
  });
  expect(applied.ok).toBe(true);
  return {
    code: totpCode(secret, Math.floor(Date.now() / 1000)),
    k_totp: encodeBase64url(kTotp),
  };
}

async function modeAt(mesh: Mesh, origin: string) {
  const res = await call(mesh.runtime, 'http://localhost/api/auth/mode', {
    headers: { origin },
    clientIp: '203.0.113.10',
  });
  return (await res.json()) as {
    passkeysForThisOrigin: boolean;
    passkeySecondFactor?: boolean;
    passkeysRegisteredElsewhere?: boolean;
    secondFactorPolicy?: string;
    totpEnabled?: boolean;
  };
}

describe('passkey second factor is scoped to the request origin', () => {
  test('a recognized entry origin can sign in with the password alone', async () => {
    const mesh = await bootMesh();
    const restore = declareSiteUrl(ORIGIN_B);
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);

      const modeB = await modeAt(mesh, ORIGIN_B);
      expect(modeB.passkeysForThisOrigin).toBe(false);
      expect(modeB.passkeySecondFactor).toBe(false);
      expect(modeB.passkeysRegisteredElsewhere).toBe(true);
      expect(modeB.secondFactorPolicy).toBe('none');

      const loginB = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
      });
      expect(loginB.res.status).toBe(200);
    } finally {
      restore();
      mesh.close();
    }
  });

  // 已知入口的大小写 / 默认端口 / 尾斜杠变体：凭证归属与入口比对若用两把尺子，
  // 正好凑出「这里没有凭证 + 命中已知入口」的放行组合。
  test('a non-canonical variant of a known entry origin is rejected', async () => {
    const mesh = await bootMesh();
    const restore = declareSiteUrl(ORIGIN_B);
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);

      for (const variant of [ORIGIN_B.toUpperCase(), `${ORIGIN_B}:443`, `${ORIGIN_B}/`]) {
        const res = await challengeAndLogin(mesh.runtime, mesh.boot, {
          clientIp: '203.0.113.10',
          headers: { origin: variant },
        });
        expect(res.res.status).toBe(401);
        expect((await res.res.json()).code).toBe('PASSKEY_REQUIRED');
      }

      const canonical = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
      });
      expect(canonical.res.status).toBe(200);
    } finally {
      restore();
      mesh.close();
    }
  });

  // Origin 头不可验证：陌生 origin 不能靠「这里没有凭证」把二次验证跳过去。
  test('a forged origin is rejected, with or without a bogus totp field', async () => {
    const mesh = await bootMesh();
    const restore = declareSiteUrl(ORIGIN_B);
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);

      const forged = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_FORGED },
      });
      expect(forged.res.status).toBe(401);
      expect((await forged.res.json()).code).toBe('PASSKEY_REQUIRED');

      // 账号没开两步验证，硬塞一个 totp 字段不会让它变成「已过 2FA」。
      const withBogusTotp = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_FORGED },
        totp: { code: '000000', k_totp: encodeBase64url(new Uint8Array(32)) },
      });
      expect(withBogusTotp.res.status).toBe(401);
      expect((await withBogusTotp.res.json()).code).toBe('PASSKEY_REQUIRED');
    } finally {
      restore();
      mesh.close();
    }
  });

  // 开了两步验证就还有一道人为验证：陌生 origin 也可以只靠密码 + TOTP 进来。
  test('an unknown origin is allowed once TOTP is verified', async () => {
    const mesh = await bootMesh();
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);
      const totp = await enableTotp(mesh);

      const missing = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_FORGED },
      });
      expect(missing.res.status).toBe(401);
      expect((await missing.res.json()).code).toBe('TOTP_REQUIRED');

      const wrong = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_FORGED },
        totp: { code: '000000', k_totp: totp.k_totp },
      });
      expect(wrong.res.status).toBe(401);
      expect((await wrong.res.json()).code).toBe('TOTP_INVALID');

      const ok = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_FORGED },
        totp,
      });
      expect(ok.res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('the registered origin still requires the assertion', async () => {
    const mesh = await bootMesh();
    try {
      const enrolled = await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);

      const modeA = await modeAt(mesh, ORIGIN_A);
      expect(modeA.passkeysForThisOrigin).toBe(true);
      expect(modeA.passkeySecondFactor).toBe(true);
      expect(modeA.passkeysRegisteredElsewhere).toBe(false);
      expect(modeA.secondFactorPolicy).toBe('passkey');

      const missing = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_A },
      });
      expect(missing.res.status).toBe(401);
      expect((await missing.res.json()).code).toBe('PASSKEY_REQUIRED');

      const ok = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_A },
        passkey: assertionFor(enrolled, 1),
      });
      expect(ok.res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('the registered origin accepts a verified TOTP instead of the assertion', async () => {
    const mesh = await bootMesh();
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);
      const totp = await enableTotp(mesh);
      const modeA = await modeAt(mesh, ORIGIN_A);
      expect(modeA.totpEnabled).toBe(true);
      expect(modeA.secondFactorPolicy).toBe('either');

      const totpOnly = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_A },
        totp,
      });
      expect(totpOnly.res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('a non-canonical Origin is still rejected after TOTP', async () => {
    const mesh = await bootMesh();
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);
      const totp = await enableTotp(mesh);
      const res = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: `${ORIGIN_A}/` },
        totp,
      });
      expect(res.res.status).toBe(401);
      expect((await res.res.json()).code).toBe('PASSKEY_REQUIRED');
    } finally {
      mesh.close();
    }
  });

  // standalone 没有 mesh link，站点 URL 只存在库里：换了反代域名的单机实例必须还能用密码登录。
  test('a standalone instance trusts its saved site URL', async () => {
    migrate(getDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
    const previousSiteUrl = getSiteSettings().siteUrl;
    const restore = declareSiteUrl(null);
    updateSiteSettings({ siteUrl: ORIGIN_B });
    const mesh = await bootMesh({ roles: { hub: false, node: false, relay: false } });
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);

      const saved = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
      });
      expect(saved.res.status).toBe(200);

      // 只有存下来的那个地址算数，别的 origin 照旧拒绝。
      const other = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_FORGED },
      });
      expect(other.res.status).toBe(401);
      expect((await other.res.json()).code).toBe('PASSKEY_REQUIRED');
    } finally {
      updateSiteSettings({ siteUrl: previousSiteUrl });
      restore();
      mesh.close();
    }
  });

  test('a credential from another origin cannot satisfy this origin', async () => {
    const mesh = await bootMesh();
    try {
      const atA = await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_B);

      const res = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
        passkey: assertionFor(atA, 1),
      });
      expect(res.res.status).toBe(401);
      expect((await res.res.json()).code).toBe('PASSKEY_INVALID');
    } finally {
      mesh.close();
    }
  });
});

describe('gatePasskeySecondFactor', () => {
  const key = (origin: string, fill: number) =>
    ({ credentialId: new Uint8Array(4).fill(fill), origin }) as never;
  const base = { uid: 'u', totpVerified: false, entryOrigins: [] as string[] };

  test('scope splits keys by exact origin', () => {
    const scope = passkeyOriginScope([key(ORIGIN_A, 1)], ORIGIN_B);
    expect(scope.here).toHaveLength(0);
    expect(scope.registeredElsewhere).toBe(true);
    expect(passkeyOriginScope([], ORIGIN_B).registeredElsewhere).toBe(false);
  });

  test('origins compare by canonical scheme + host + port', () => {
    expect(canonicalOrigin('https://a.example/n/abc?x=1')).toBe('https://a.example');
    expect(canonicalOrigin('HTTPS://A.example:443/')).toBe('https://a.example');
    expect(canonicalOrigin('a.example')).toBeNull();
    expect(canonicalOrigin(null)).toBeNull();
    expect(isKnownEntryOrigin('https://a.example', ['https://a.example/n/x'])).toBe(true);
    expect(isKnownEntryOrigin('https://a.example:8443', ['https://a.example'])).toBe(false);
    expect(isKnownEntryOrigin('https://a.example', [null, undefined, ''])).toBe(false);
    // 凭证归属用同一把尺子：历史行里带默认端口也仍然算「这个 origin 的钥匙」。
    expect(sameCanonicalOrigin('https://a.example:443', 'https://a.example')).toBe(true);
    expect(sameCanonicalOrigin('https://a.example', 'http://a.example')).toBe(false);
    expect(sameCanonicalOrigin(null, 'https://a.example')).toBe(false);
    const scope = passkeyOriginScope([key('https://a.example:443', 3)], 'https://a.example');
    expect(scope.here).toHaveLength(1);
    expect(scope.registeredElsewhere).toBe(false);
  });

  test('a non-canonical Origin never buys a skip', () => {
    for (const variant of [
      `${ORIGIN_B.toUpperCase()}`,
      `${ORIGIN_B}:443`,
      `${ORIGIN_B}/`,
      `${ORIGIN_B}/n/abc`,
    ]) {
      expect(
        gatePasskeySecondFactor({
          ...base,
          entryOrigins: [ORIGIN_B],
          keys: [key(ORIGIN_A, 1)],
          origin: variant,
          body: null,
        })
      ).toEqual({ kind: 'reject', code: 'PASSKEY_REQUIRED', usableHere: false });
    }
    // 规范形态照旧放行。
    expect(
      gatePasskeySecondFactor({
        ...base,
        entryOrigins: [ORIGIN_B],
        keys: [key(ORIGIN_A, 1)],
        origin: ORIGIN_B,
        body: null,
      }).kind
    ).toBe('skip');
    // 名下没有通行密钥时这条不适用（本来就没有可绕的东西）。
    expect(
      gatePasskeySecondFactor({ ...base, keys: [], origin: `${ORIGIN_B}/`, body: null }).kind
    ).toBe('skip');
  });

  test('this origin has a key: the assertion decides', () => {
    const foreign = gatePasskeySecondFactor({
      ...base,
      keys: [key(ORIGIN_A, 1), key(ORIGIN_B, 2)],
      origin: ORIGIN_B,
      body: { credential_id: encodeBase64url(new Uint8Array(4).fill(1)), sig: 'x' },
    });
    expect(foreign).toEqual({ kind: 'reject', code: 'PASSKEY_INVALID', usableHere: true });

    const missing = gatePasskeySecondFactor({
      ...base,
      keys: [key(ORIGIN_B, 2)],
      origin: ORIGIN_B,
      body: null,
    });
    expect(missing).toEqual({ kind: 'reject', code: 'PASSKEY_REQUIRED', usableHere: true });

    const good = gatePasskeySecondFactor({
      ...base,
      keys: [key(ORIGIN_B, 2)],
      origin: ORIGIN_B,
      body: { credential_id: encodeBase64url(new Uint8Array(4).fill(2)), sig: 'sig' },
    });
    expect(good).toEqual({
      kind: 'verify',
      credentialId: encodeBase64url(new Uint8Array(4).fill(2)),
      sig: 'sig',
    });
  });

  test('no key here: only no-passkey / TOTP / known entry may skip', () => {
    // 名下压根没有通行密钥：这一关不存在。
    expect(
      gatePasskeySecondFactor({ ...base, keys: [], origin: ORIGIN_FORGED, body: null }).kind
    ).toBe('skip');

    // 伪造 Origin，没有 TOTP、也不是已知入口 → 必须拒绝。
    expect(
      gatePasskeySecondFactor({
        ...base,
        keys: [key(ORIGIN_A, 1)],
        origin: ORIGIN_FORGED,
        body: null,
      })
    ).toEqual({ kind: 'reject', code: 'PASSKEY_REQUIRED', usableHere: false });

    // 已过 TOTP：2FA 仍然成立（含本 origin 有钥匙、以及缺 Origin）。
    expect(
      gatePasskeySecondFactor({
        ...base,
        totpVerified: true,
        keys: [key(ORIGIN_A, 1)],
        origin: ORIGIN_FORGED,
        body: null,
      }).kind
    ).toBe('skip');
    expect(
      gatePasskeySecondFactor({
        ...base,
        totpVerified: true,
        keys: [key(ORIGIN_B, 2)],
        origin: ORIGIN_B,
        body: null,
      }).kind
    ).toBe('skip');
    expect(
      gatePasskeySecondFactor({
        ...base,
        totpVerified: true,
        keys: [key(ORIGIN_A, 1)],
        origin: '',
        body: null,
      }).kind
    ).toBe('skip');
    expect(
      gatePasskeySecondFactor({
        ...base,
        totpVerified: true,
        keys: [key(ORIGIN_A, 1)],
        origin: `${ORIGIN_B}/`,
        body: null,
      })
    ).toEqual({ kind: 'reject', code: 'PASSKEY_REQUIRED', usableHere: false });

    // 服务端自己配置的入口地址。
    expect(
      gatePasskeySecondFactor({
        ...base,
        entryOrigins: [`${ORIGIN_B}/n/abc`],
        keys: [key(ORIGIN_A, 1)],
        origin: ORIGIN_B,
        body: null,
      }).kind
    ).toBe('skip');
  });
});

describe('resolveSecondFactors / verifySecondFactors', () => {
  const totpOff = { ok: true as const, verified: false, enrolled: false };
  const totpOn = { ok: true as const, verified: false, enrolled: true };
  const totpOk = { ok: true as const, verified: true, enrolled: true };
  const totpBad = { ok: false as const, code: 'TOTP_INVALID' };
  const pkSkip = { ok: true as const, assertionVerified: false };
  const pkOk = { ok: true as const, assertionVerified: true };
  const pkNeedHere = { ok: false as const, code: 'PASSKEY_REQUIRED', usableHere: true };
  const pkNeedElse = { ok: false as const, code: 'PASSKEY_REQUIRED', usableHere: false };
  const pkBad = { ok: false as const, code: 'PASSKEY_INVALID' };

  test('decision table: either factor, no fallthrough on a wrong TOTP', () => {
    expect(resolveSecondFactors(totpOk, pkSkip)).toEqual({ ok: true });
    expect(resolveSecondFactors(totpOk, pkNeedHere)).toEqual({
      ok: false,
      code: 'PASSKEY_REQUIRED',
    });
    expect(resolveSecondFactors(totpOn, pkOk)).toEqual({ ok: true });
    expect(resolveSecondFactors(totpOn, pkNeedHere)).toEqual({
      ok: false,
      code: 'PASSKEY_REQUIRED',
    });
    expect(resolveSecondFactors(totpOn, pkNeedElse)).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
    expect(resolveSecondFactors(totpOn, pkSkip)).toEqual({ ok: false, code: 'TOTP_REQUIRED' });
    expect(resolveSecondFactors(totpOn, pkBad)).toEqual({ ok: false, code: 'PASSKEY_INVALID' });
    expect(resolveSecondFactors(totpBad, pkOk)).toEqual({ ok: false, code: 'TOTP_INVALID' });
    expect(resolveSecondFactors(totpOff, pkSkip)).toEqual({ ok: true });
    expect(resolveSecondFactors(totpOff, pkNeedHere)).toEqual({
      ok: false,
      code: 'PASSKEY_REQUIRED',
    });
  });

  test('verifySecondFactors does not call the passkey gate after TOTP_INVALID', async () => {
    let passkeyCalls = 0;
    const result = await verifySecondFactors({
      checkTotp: async () => totpBad,
      checkPasskeySecondFactor: async () => {
        passkeyCalls += 1;
        return pkOk;
      },
      req: new Request('http://localhost/api/auth/login'),
      user: { id: 'u' } as never,
      delegation: { method: 'root' } as never,
      body: { totp: { code: '000000' } },
    });
    expect(result).toEqual({ ok: false, code: 'TOTP_INVALID' });
    expect(passkeyCalls).toBe(0);
  });

  test('verifySecondFactors forwards totpVerified into the passkey gate', async () => {
    let seen: boolean | undefined;
    const result = await verifySecondFactors({
      checkTotp: async () => totpOk,
      checkPasskeySecondFactor: async (_r, _u, _d, _p, totpVerified) => {
        seen = totpVerified;
        return pkSkip;
      },
      req: new Request('http://localhost/api/auth/login'),
      user: { id: 'u' } as never,
      delegation: { method: 'root' } as never,
      body: {},
    });
    expect(seen).toBe(true);
    expect(result).toEqual({ ok: true });
  });
});
