import { describe, expect, test } from 'bun:test';
import { encodeBase64url, generateEd25519KeyPair } from '@vibeterm/shared/auth';
import { isAuthLoginPublicPath } from './auth-public-paths';
import {
  ENTRY_ID,
  MINUTE,
  boot,
  codeOf,
  currentCode,
  enrollTotp,
  envelope,
  issue,
  newCode,
  post,
  redeem,
  sidOf,
  statusOf,
} from './login-code-test-support';

describe('签发登录命令', () => {
  test('新签的根委托：201 并带过期时间', async () => {
    const mesh = await boot();
    try {
      const { res } = await issue(mesh);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expires_at: number };
      expect(body.expires_at).toBe(mesh.now() + 10 * MINUTE);
      expect(sidOf(res)).toBe('');
    } finally {
      mesh.close();
    }
  });

  test('旧委托 + 现场验证码通过；旧委托不带验证码要求加强验证', async () => {
    const mesh = await boot();
    try {
      const { secret, kTotp } = await enrollTotp(mesh);
      const issuedAt = mesh.now() - 6 * MINUTE;
      const ok = await issue(mesh, {
        issuedAt,
        totp: { code: currentCode(mesh, secret), k_totp: kTotp },
      });
      expect(ok.res.status).toBe(201);

      const noTotp = await issue(mesh, { issuedAt });
      expect(noTotp.res.status).toBe(401);
      expect(await codeOf(noTotp.res)).toBe('TOTP_REQUIRED');
    } finally {
      mesh.close();
    }
  });

  test('无 TOTP 的账户：旧委托 → STEP_UP_REQUIRED', async () => {
    const mesh = await boot();
    try {
      const { res } = await issue(mesh, { issuedAt: mesh.now() - 6 * MINUTE });
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe('STEP_UP_REQUIRED');
    } finally {
      mesh.close();
    }
  });

  test('验证码已被本节点登录用过（同 / 不同会话公钥）→ TOTP_ALREADY_USED', async () => {
    const mesh = await boot();
    try {
      const { secret, kTotp } = await enrollTotp(mesh);
      const sess = generateEd25519KeyPair();
      const totp = { code: currentCode(mesh, secret), k_totp: kTotp };
      const loginBody = await envelope(mesh, { sess, totp });
      const login = await post(mesh, '/api/auth/login', loginBody);
      expect(login.status).toBe(200);

      const issuedAt = mesh.now() - 6 * MINUTE;
      const same = await issue(mesh, { sess, totp, issuedAt });
      expect(same.res.status).toBe(401);
      expect(await codeOf(same.res)).toBe('TOTP_ALREADY_USED');
      const other = await issue(mesh, { totp, issuedAt });
      expect(await codeOf(other.res)).toBe('TOTP_ALREADY_USED');
    } finally {
      mesh.close();
    }
  });

  test('签发用过的验证码再签发也拒绝；普通登录同会话公钥复用不受影响', async () => {
    const mesh = await boot();
    try {
      const { secret, kTotp } = await enrollTotp(mesh);
      const sess = generateEd25519KeyPair();
      const totp = { code: currentCode(mesh, secret), k_totp: kTotp };
      const issuedAt = mesh.now() - 6 * MINUTE;
      expect((await issue(mesh, { sess, totp, issuedAt })).res.status).toBe(201);
      const again = await issue(mesh, { sess, totp, issuedAt });
      expect(await codeOf(again.res)).toBe('TOTP_ALREADY_USED');

      const first = await post(mesh, '/api/auth/login', await envelope(mesh, { sess, totp }));
      expect(first.status).toBe(200);
      const fanOut = await post(mesh, '/api/auth/login', await envelope(mesh, { sess, totp }));
      expect(fanOut.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('challenge 种类互不通用', async () => {
    const mesh = await boot();
    try {
      const loginWithCodeChallenge = await envelope(mesh, { purpose: 'login-code' });
      const res = await post(mesh, '/api/auth/login', loginWithCodeChallenge);
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe('CHALLENGE_CONSUMED');

      const issueWithLoginChallenge = await envelope(mesh);
      const res2 = await post(mesh, '/api/auth/login-code', {
        ...issueWithLoginChallenge,
        code_hash: newCode().hash,
      });
      expect(res2.status).toBe(401);
      expect(await codeOf(res2)).toBe('CHALLENGE_CONSUMED');

      const bad = await post(mesh, '/api/auth/challenge', {
        uid: mesh.user.userId,
        purpose: 'other',
      });
      expect(bad.status).toBe(400);
    } finally {
      mesh.close();
    }
  });

  test('code_hash 格式不对 → MALFORMED；重复哈希 → MALFORMED', async () => {
    const mesh = await boot();
    try {
      const body = await envelope(mesh, { purpose: 'login-code' });
      const res = await post(mesh, '/api/auth/login-code', { ...body, code_hash: 'AAAA' });
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('MALFORMED');

      const code = newCode();
      expect((await issue(mesh, {}, code)).res.status).toBe(201);
      const dup = await issue(mesh, {}, code);
      expect(dup.res.status).toBe(400);
    } finally {
      mesh.close();
    }
  });

  test('通行密钥方式的新委托可签发，兑换出的会话带 credential', async () => {
    const mesh = await boot();
    try {
      const credentialId = new Uint8Array(16).fill(4);
      mesh.userStore.insertKey({
        id: crypto.randomUUID(),
        userId: mesh.user.userId,
        credentialId,
        publicKey: new Uint8Array(32).fill(4),
        rpId: 'localhost',
        origin: 'http://localhost',
        counter: 0,
        name: 'key',
        logSeq: 1,
        now: mesh.now(),
      });
      const cred = encodeBase64url(credentialId);
      const { res, code } = await issue(mesh, { passkeyCredential: cred });
      expect(res.status).toBe(201);
      const redeemed = await redeem(mesh, code.code);
      expect(redeemed.status).toBe(200);
      const verified = mesh.nodeSessionStore.verify(sidOf(redeemed), {
        viaNodeId: 'self',
        now: mesh.now(),
      });
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.session.delegationMethod).toBe('passkey');
        expect(verified.session.credentialId).toEqual(credentialId);
      }

      const stale = await issue(mesh, {
        passkeyCredential: cred,
        issuedAt: mesh.now() - 6 * MINUTE,
      });
      expect(await codeOf(stale.res)).toBe('STEP_UP_REQUIRED');
    } finally {
      mesh.close();
    }
  });
});

describe('兑换登录命令', () => {
  test('成功：会话绑定 via、会话公钥与 PoP 标记；第二次兑换报已使用', async () => {
    const mesh = await boot();
    try {
      const { code } = await issue(mesh);
      const sess = generateEd25519KeyPair();
      const res = await redeem(mesh, code.code, { pop: true, sess });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { expires_at: number; uid: string; username: string };
      expect(body.uid).toBe(mesh.user.userId);
      expect(body.username).toBe('alice');
      const verified = mesh.nodeSessionStore.verify(sidOf(res), {
        viaNodeId: 'self',
        now: mesh.now(),
      });
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.session.sessPublicKey).toEqual(sess.publicKey);
        expect(verified.session.popRequired).toBe(true);
        expect(verified.session.delegationMethod).toBe('root');
      }

      const again = await redeem(mesh, code.code);
      expect(again.status).toBe(401);
      expect(await codeOf(again)).toBe('LOGIN_CODE_USED');
      expect(await statusOf(mesh, code.code)).toBe('used');
    } finally {
      mesh.close();
    }
  });

  test('经入口签发与兑换：会话 via 为入口，旧入口不签 PoP', async () => {
    const mesh = await boot();
    try {
      const { res: issued, code } = await issue(mesh, { via: ENTRY_ID });
      expect(issued.status).toBe(201);
      const res = await redeem(mesh, code.code, { via: ENTRY_ID, pop: true });
      expect(res.status).toBe(200);
      const sid = sidOf(res);
      expect(mesh.nodeSessionStore.verify(sid, { viaNodeId: 'self', now: mesh.now() }).ok).toBe(
        false
      );
      const verified = mesh.nodeSessionStore.verify(sid, { viaNodeId: ENTRY_ID, now: mesh.now() });
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.session.popRequired).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('过期、作废、未知、格式错误', async () => {
    const mesh = await boot();
    try {
      const expired = await issue(mesh);
      const revoked = await issue(mesh);
      const revokeRes = await post(mesh, '/api/auth/login-code/revoke', {
        code: revoked.code.code,
      });
      expect(revokeRes.status).toBe(200);
      expect(((await revokeRes.json()) as { state: string }).state).toBe('revoked');
      expect(await codeOf(await redeem(mesh, revoked.code.code))).toBe('LOGIN_CODE_REVOKED');

      mesh.advance(10 * MINUTE);
      const res = await redeem(mesh, expired.code.code);
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe('LOGIN_CODE_EXPIRED');
      expect(await statusOf(mesh, expired.code.code)).toBe('expired');

      expect(await codeOf(await redeem(mesh, newCode().code))).toBe('LOGIN_CODE_INVALID');
      const malformed = await post(mesh, '/api/auth/login-code/redeem', {
        code: 'short',
        sess_pk: encodeBase64url(new Uint8Array(32)),
      });
      expect(malformed.status).toBe(400);
    } finally {
      mesh.close();
    }
  });

  test('并发兑换只有一个成功', async () => {
    const mesh = await boot();
    try {
      const { code } = await issue(mesh);
      const results = await Promise.all([redeem(mesh, code.code), redeem(mesh, code.code)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 401]);
    } finally {
      mesh.close();
    }
  });
});

describe('查询 / 作废 / 连带作废', () => {
  test('status 与 revoke：未知 404，revoke 幂等', async () => {
    const mesh = await boot();
    try {
      const unknown = await post(mesh, '/api/auth/login-code/status', { code: newCode().code });
      expect(unknown.status).toBe(404);
      expect(await codeOf(unknown)).toBe('LOGIN_CODE_INVALID');

      const { res, code } = await issue(mesh);
      const expiresAt = ((await res.json()) as { expires_at: number }).expires_at;
      const status = await post(mesh, '/api/auth/login-code/status', { code: code.code });
      expect(await status.json()).toEqual({
        state: 'pending',
        expires_at: expiresAt,
        used_at: null,
      });
      for (let i = 0; i < 2; i++) {
        const revoked = await post(mesh, '/api/auth/login-code/revoke', { code: code.code });
        expect(revoked.status).toBe(200);
        expect(((await revoked.json()) as { state: string }).state).toBe('revoked');
      }
    } finally {
      mesh.close();
    }
  });

  test('revokeAllSessions / revoke-node / remove-passkey 效果作废待兑换码', async () => {
    const mesh = await boot();
    try {
      const own = await issue(mesh);
      const viaEntry = await issue(mesh, { via: ENTRY_ID });
      mesh.routes.applyKeyLogEffects(mesh.user.userId, [
        { type: 'revokeSessionsVia', nodeId: Uint8Array.from(Buffer.from(ENTRY_ID, 'hex')) },
      ]);
      expect(await statusOf(mesh, viaEntry.code.code)).toBe('revoked');
      expect(await statusOf(mesh, own.code.code)).toBe('pending');

      mesh.routes.applyKeyLogEffects(mesh.user.userId, [{ type: 'revokeAllSessions' }]);
      expect(await statusOf(mesh, own.code.code)).toBe('revoked');
    } finally {
      mesh.close();
    }
  });

  test('本节点登出作废该用户的待兑换码', async () => {
    const mesh = await boot();
    try {
      const first = await issue(mesh);
      const pending = await issue(mesh);
      const session = await redeem(mesh, first.code.code);
      const sid = sidOf(session);
      const logout = await post(mesh, '/api/auth/logout', {}, { cookie: `vibeterm_s_self=${sid}` });
      expect(logout.status).toBe(200);
      expect(await statusOf(mesh, pending.code.code)).toBe('revoked');
      expect(await statusOf(mesh, first.code.code)).toBe('used');
    } finally {
      mesh.close();
    }
  });

  test('四个接口只在 POST 时属于公开面', () => {
    for (const path of [
      '/api/auth/login-code',
      '/api/auth/login-code/redeem',
      '/api/auth/login-code/status',
      '/api/auth/login-code/revoke',
    ]) {
      expect(isAuthLoginPublicPath(path, 'POST')).toBe(true);
      expect(isAuthLoginPublicPath(path, 'GET')).toBe(false);
    }
  });
});
