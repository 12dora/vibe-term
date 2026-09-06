// 通行密钥二次验证按 origin 生效的 HTTP 契约（背景见 docs/auth/2026090701-passkey-per-origin.md）。
// 断言只能在注册它的 origin 完成，所以「另一个入口域名」必须能只凭密码（+ TOTP）登录，
// 而注册过通行密钥的那个 origin 一如既往要过断言。

import { describe, expect, test } from 'bun:test';
import {
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeSetTotpPayload,
  encryptTotpSecret,
  sha256,
  totpCode,
} from '@vibeterm/shared/auth';
import { encodePasskeyAssertionSig, verifyRegistration } from '../auth/passkey';
import { createEs256Authenticator } from '../auth/passkey-test-fixtures';
import { kdfParamsFromJson } from '../auth/user-key-service';
import type { UserStore } from '../auth/user-store';
import { gatePasskeySecondFactor, passkeyOriginScope } from './auth-passkey-origin';
import { PASSWORD, bootMesh, call, challengeAndLogin } from './auth-routes.test';

const ORIGIN_A = 'https://relay.example';
const ORIGIN_B = 'https://tunnel.example';

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
  };
}

describe('passkey second factor is scoped to the request origin', () => {
  test('another origin can sign in with the password alone', async () => {
    const mesh = await bootMesh();
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);

      const modeB = await modeAt(mesh, ORIGIN_B);
      expect(modeB.passkeysForThisOrigin).toBe(false);
      expect(modeB.passkeySecondFactor).toBe(false);
      expect(modeB.passkeysRegisteredElsewhere).toBe(true);

      const loginB = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
      });
      expect(loginB.res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('another origin still has to pass TOTP when it is enabled', async () => {
    const mesh = await bootMesh();
    try {
      await enrollPasskeyAt(mesh.userStore, mesh.boot.userId, ORIGIN_A);
      const totp = await enableTotp(mesh);

      const missing = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
      });
      expect(missing.res.status).toBe(401);
      expect((await missing.res.json()).code).toBe('TOTP_REQUIRED');

      const ok = await challengeAndLogin(mesh.runtime, mesh.boot, {
        clientIp: '203.0.113.10',
        headers: { origin: ORIGIN_B },
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

  test('scope splits keys by exact origin', () => {
    const scope = passkeyOriginScope([key(ORIGIN_A, 1)], ORIGIN_B);
    expect(scope.here).toHaveLength(0);
    expect(scope.registeredElsewhere).toBe(true);
    expect(passkeyOriginScope([], ORIGIN_B).registeredElsewhere).toBe(false);
  });

  test('skips when this origin has no key, rejects a foreign credential', () => {
    expect(
      gatePasskeySecondFactor({ keys: [key(ORIGIN_A, 1)], origin: ORIGIN_B, uid: 'u', body: null })
        .kind
    ).toBe('skip');

    const foreign = gatePasskeySecondFactor({
      keys: [key(ORIGIN_A, 1), key(ORIGIN_B, 2)],
      origin: ORIGIN_B,
      uid: 'u',
      body: { credential_id: encodeBase64url(new Uint8Array(4).fill(1)), sig: 'x' },
    });
    expect(foreign).toEqual({ kind: 'reject', code: 'PASSKEY_INVALID' });

    const missing = gatePasskeySecondFactor({
      keys: [key(ORIGIN_B, 2)],
      origin: ORIGIN_B,
      uid: 'u',
      body: null,
    });
    expect(missing).toEqual({ kind: 'reject', code: 'PASSKEY_REQUIRED' });

    const good = gatePasskeySecondFactor({
      keys: [key(ORIGIN_B, 2)],
      origin: ORIGIN_B,
      uid: 'u',
      body: { credential_id: encodeBase64url(new Uint8Array(4).fill(2)), sig: 'sig' },
    });
    expect(good).toEqual({
      kind: 'verify',
      credentialId: encodeBase64url(new Uint8Array(4).fill(2)),
      sig: 'sig',
    });
  });
});
