import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import { AuthApi, type AuthModeResponse, type MeshNode } from '@vibeterm/api-client/auth/index';
import {
  createDelegation,
  decodeBase64url,
  decodeLogin,
  decodeLoginCode,
  deriveNodeLoginCode,
  encodeBase64url,
  generateEd25519KeyPair,
  loginCodeHash,
  rootKeyFromSeed,
  verifyLogin,
} from '@vibeterm/shared/auth';
import {
  type LoginCodeContext,
  type LoginCodeTarget,
  disposeLoginCode,
  issueLoginCode,
  loginCodeProofKinds,
  planLoginCodeTargets,
  pollLoginCodeStates,
  revokeLoginCode,
} from './login-code-issue';
import type { SessionKeySecrets } from './session-key-types';

const UID = 'alice';
const SELF = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
const NOW = 1_800_000_000_000;

const fill = (length: number, value: number) => new Uint8Array(length).fill(value);
const PKS: Record<string, Uint8Array> = {
  self: fill(32, 0x55),
  [NODE_A]: fill(32, 0x22),
  [NODE_B]: fill(32, 0x33),
};
const MESH_PK: Record<string, Uint8Array> = { [SELF]: PKS.self as Uint8Array, ...PKS };

function mode(overrides: Partial<AuthModeResponse> = {}): AuthModeResponse {
  return {
    mode: 'mesh',
    nodeId: SELF,
    uid: UID,
    username: 'alice',
    kdfParams: { salt: encodeBase64url(fill(16, 1)), memory_kib: 8, iterations: 1, parallelism: 1 },
    passkeysForThisOrigin: false,
    passkeyAvailable: false,
    totpEnabled: true,
    rootEpoch: 0,
    ...overrides,
  };
}

function row(id: string, extra: Partial<MeshNode> = {}): MeshNode {
  return {
    id,
    name: `n-${id.slice(0, 2)}`,
    publicKey: encodeBase64url(MESH_PK[id] ?? fill(32, 9)),
    online: true,
    reach: 'lan',
    version: '2.17.0',
    direct_capable: true,
    loggedIn: true,
    ...extra,
  };
}

function rootSecrets(overrides: Partial<SessionKeySecrets> = {}): SessionKeySecrets {
  const pair = generateEd25519KeyPair();
  const signed = createDelegation(rootKeyFromSeed(fill(32, 0x11)), {
    uid: UID,
    sessPk: pair.publicKey,
    now: NOW - 60 * 60 * 1000,
  });
  return {
    info: {
      uid: UID,
      entryNodeId: SELF,
      method: 'root',
      issuedAt: Number(signed.delegation.issued_at),
      expiresAt: Number(signed.delegation.exp),
      hasTotp: true,
      credentialId: null,
    },
    sessKey: null,
    sessSk: pair.secretKey,
    sessPk: pair.publicKey,
    delegation: signed.delegation,
    delegationBytes: signed.bytes,
    delegationSig: signed.sig,
    passkeyCredentialId: null,
    passkeySig: null,
    kTotp: fill(32, 0x77),
    totpCode: null,
    ...overrides,
  };
}

interface Call {
  nodeId: string;
  kind: string;
  body: Record<string, unknown>;
}

function fakeApi(opts: { issue?: (nodeId: string) => Response; state?: string } = {}) {
  const calls: Call[] = [];
  const client = new ApiClient('', (url, init) => {
    const match =
      /^(?:\/n\/([0-9a-f]{32}))?\/api\/auth\/(challenge|login-code(?:\/status|\/revoke)?)$/.exec(
        url
      );
    if (!match) return Promise.resolve(new Response('nope', { status: 404 }));
    const nodeId = match[1] ?? 'self';
    const kind = match[2] as string;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ nodeId, kind, body });
    if (kind === 'challenge') {
      return Promise.resolve(
        Response.json({
          challenge_id: `c-${nodeId}`,
          nonce: encodeBase64url(fill(32, 0x44)),
          nodePk: encodeBase64url(PKS[nodeId] as Uint8Array),
        })
      );
    }
    if (kind === 'login-code') {
      return Promise.resolve(
        opts.issue?.(nodeId) ?? Response.json({ expires_at: NOW + 600_000 }, { status: 201 })
      );
    }
    return Promise.resolve(
      Response.json({ state: opts.state ?? 'pending', expires_at: NOW + 600_000, used_at: null })
    );
  });
  return { api: new AuthApi(client, { clientKind: 'web' }), calls };
}

function context(overrides: Partial<AuthModeResponse> = {}): LoginCodeContext {
  const m = mode(overrides);
  return { mode: m, selfMeshId: SELF, proofKinds: ['totp'], totpEnabled: Boolean(m.totpEnabled) };
}

const TARGETS: LoginCodeTarget[] = planLoginCodeTargets(
  [row(NODE_A), row(SELF), row(NODE_B)],
  'all',
  SELF
).targets;

describe('loginCodeProofKinds', () => {
  test('当前密码会话 + k_totp 才提供验证码；通行密钥按本地址可用性', () => {
    const secrets = rootSecrets();
    expect(loginCodeProofKinds(mode(), secrets, { now: NOW, webauthnSupported: true })).toEqual([
      'totp',
    ]);
    const passkeyMode = mode({ passkeyAvailable: true, passkeysForThisOrigin: true });
    expect(
      loginCodeProofKinds(passkeyMode, secrets, { now: NOW, webauthnSupported: true })
    ).toEqual(['totp', 'passkey']);
    expect(
      loginCodeProofKinds(passkeyMode, secrets, { now: NOW, webauthnSupported: false })
    ).toEqual(['totp']);
  });

  test('passkey 会话、无 k_totp、未开 TOTP、delegation 过期都退回密码', () => {
    const secrets = rootSecrets();
    const opts = { now: NOW, webauthnSupported: true };
    expect(loginCodeProofKinds(mode({ totpEnabled: false }), secrets, opts)).toEqual(['password']);
    expect(loginCodeProofKinds(mode(), rootSecrets({ kTotp: null }), opts)).toEqual(['password']);
    expect(loginCodeProofKinds(mode(), null, opts)).toEqual(['password']);
    const passkeySession = rootSecrets();
    passkeySession.delegation = { ...passkeySession.delegation, method: 'passkey' } as never;
    expect(loginCodeProofKinds(mode(), passkeySession, opts)).toEqual(['password']);
    expect(
      loginCodeProofKinds(mode(), secrets, {
        now: Number(secrets.delegation.exp),
        webauthnSupported: true,
      })
    ).toEqual(['password']);
  });
});

describe('planLoginCodeTargets', () => {
  test('self 恒在首位且为 self 运行时 id；离线 / 暂停 / 过旧 / 缺版本跳过', () => {
    const plan = planLoginCodeTargets(
      [
        row(NODE_A),
        row(NODE_B, { online: false }),
        row('0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c', { paused: true }),
        row('0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d', { version: '2.16.9' }),
        row('0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', { version: null }),
        row(SELF, { version: null }),
      ],
      'all',
      SELF
    );
    expect(plan.targets.map((t) => [t.meshId, t.runtimeId])).toEqual([
      [SELF, 'self'],
      [NODE_A, NODE_A],
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'offline',
      'paused',
      'outdated',
      'outdated',
    ]);
  });

  test('指定节点：只含所选，不再强行带上当前入口', () => {
    const nodes = [row(SELF), row(NODE_A), row(NODE_B)];
    const one = planLoginCodeTargets(nodes, [NODE_A], SELF);
    expect(one.targets.map((t) => t.meshId)).toEqual([NODE_A]);
    expect(one.targets[0]?.runtimeId).toBe(NODE_A);
    expect(one.skipped).toEqual([]);
    expect(planLoginCodeTargets(nodes, [SELF], SELF).targets.map((t) => t.runtimeId)).toEqual([
      'self',
    ]);
  });

  test('多选：self 选中时排首位，其余保持节点顺序；未选与重复 id 不影响结果', () => {
    const nodes = [row(NODE_A), row(NODE_B), row(SELF)];
    const plan = planLoginCodeTargets(nodes, [NODE_B, SELF, NODE_B], SELF);
    expect(plan.targets.map((t) => [t.meshId, t.runtimeId])).toEqual([
      [SELF, 'self'],
      [NODE_B, NODE_B],
    ]);
    expect(planLoginCodeTargets(nodes, [], SELF).targets).toEqual([]);
    expect(planLoginCodeTargets(nodes, ['missing'], SELF)).toEqual({ targets: [], skipped: [] });
  });

  test('多选里不可用的节点进 skipped，不进 targets', () => {
    const nodes = [row(NODE_A), row(NODE_B, { online: false }), row(SELF, { version: null })];
    const plan = planLoginCodeTargets(nodes, [NODE_A, NODE_B, SELF], SELF);
    expect(plan.targets.map((t) => t.meshId)).toEqual([SELF, NODE_A]);
    expect(plan.skipped).toEqual([{ meshId: NODE_B, name: expect.any(String), reason: 'offline' }]);
  });
});

const mismatched = (target: LoginCodeTarget): LoginCodeTarget => ({
  ...target,
  publicKey: encodeBase64url(fill(32, 1)),
});

describe('issueLoginCode', () => {
  test('验证码证明：请求体字段、code_hash 派生、purpose 与 login 绑定', async () => {
    const { api, calls } = fakeApi();
    const secrets = rootSecrets();
    const result = await issueLoginCode({
      context: context(),
      targets: TARGETS,
      proof: { kind: 'totp', code: '123456' },
      api,
      now: NOW,
      deps: { readSecrets: () => secrets },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle.command.startsWith('vibeterm login --code vtl1_')).toBe(true);
    const parts = decodeLoginCode(result.handle.command.slice('vibeterm login --code '.length));
    expect(parts?.nodeIds).toEqual([SELF, NODE_A, NODE_B]);
    expect(result.handle.expiresAt).toBe(NOW + 600_000);

    const challenges = calls.filter((c) => c.kind === 'challenge');
    expect(challenges.every((c) => c.body.purpose === 'login-code' && c.body.uid === UID)).toBe(
      true
    );
    const issues = calls.filter((c) => c.kind === 'login-code');
    expect(issues.map((c) => c.nodeId)).toEqual(['self', NODE_A, NODE_B]);
    for (const call of issues) {
      const meshId = call.nodeId === 'self' ? SELF : call.nodeId;
      const expected = encodeBase64url(loginCodeHash(deriveNodeLoginCode(parts!.secret, meshId)));
      expect(call.body.code_hash).toBe(expected);
      expect(call.body.totp).toEqual({ code: '123456', k_totp: encodeBase64url(fill(32, 0x77)) });
      expect(call.body.delegation).toBe(encodeBase64url(secrets.delegationBytes));
      expect(call.body.passkey).toBeUndefined();
      const login = decodeLogin(decodeBase64url(String(call.body.login)));
      const verdict = verifyLogin(login, decodeBase64url(String(call.body.sig)), secrets.sessPk, {
        challengeId: `c-${call.nodeId}`,
        nonce: fill(32, 0x44),
        target: call.nodeId,
        targetPk: PKS[call.nodeId] as Uint8Array,
        uid: UID,
        entry: SELF,
      });
      expect(verdict).toEqual({ ok: true });
    }
    // 全局会话材料只被拷贝，不被清零。
    expect(secrets.kTotp).toEqual(fill(32, 0x77));
    disposeLoginCode(result.handle);
  });

  test('目标不含 self：只登记所选节点，命令只含它们，状态轮询与作废也只打这些节点', async () => {
    const { api, calls } = fakeApi();
    const secrets = rootSecrets();
    const targets = planLoginCodeTargets(
      [row(SELF), row(NODE_A), row(NODE_B)],
      [NODE_B],
      SELF
    ).targets;
    const result = await issueLoginCode({
      context: context(),
      targets,
      proof: { kind: 'totp', code: '123456' },
      api,
      now: NOW,
      deps: { readSecrets: () => secrets },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parts = decodeLoginCode(result.handle.command.slice('vibeterm login --code '.length));
    expect(parts?.nodeIds).toEqual([NODE_B]);
    expect(calls.filter((c) => c.kind === 'login-code').map((c) => c.nodeId)).toEqual([NODE_B]);
    // 证明里的入口仍是会话入口，与目标无关。
    const issued = calls.find((c) => c.kind === 'login-code');
    const login = decodeLogin(decodeBase64url(String(issued?.body.login)));
    expect(login.entry).toBe(SELF);
    calls.length = 0;
    expect(await pollLoginCodeStates(result.handle)).toEqual({ [NODE_B]: 'pending' });
    await revokeLoginCode(result.handle);
    expect(calls.map((c) => c.nodeId)).toEqual([NODE_B, NODE_B]);
    disposeLoginCode(result.handle);
  });

  test('首台不是 self 且只是自己的节点问题（公钥不符）：记为该台失败，其余节点照常签发', async () => {
    const { api, calls } = fakeApi();
    const planned = planLoginCodeTargets([row(NODE_A), row(NODE_B)], 'all', SELF).targets;
    const targets = [mismatched(planned[0] as LoginCodeTarget), planned[1] as LoginCodeTarget];
    const result = await issueLoginCode({
      context: context(),
      targets,
      proof: { kind: 'totp', code: '123456' },
      api,
      now: NOW,
      deps: { readSecrets: () => rootSecrets() },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => (n.ok ? 'ok' : n.code))).toEqual(['NODE_PK_MISMATCH', 'ok']);
    expect(result.handle.meshIds).toEqual([NODE_B]);
    expect(calls.filter((c) => c.kind === 'login-code').map((c) => c.nodeId)).toEqual([NODE_B]);
    disposeLoginCode(result.handle);
  });

  test('首台是 self 时公钥不符仍整次中止', async () => {
    const { api, calls } = fakeApi();
    const planned = planLoginCodeTargets([row(SELF), row(NODE_A)], 'all', SELF).targets;
    const targets = [mismatched(planned[0] as LoginCodeTarget), planned[1] as LoginCodeTarget];
    const result = await issueLoginCode({
      context: context(),
      targets,
      proof: { kind: 'totp', code: '123456' },
      api,
      now: NOW,
      deps: { readSecrets: () => rootSecrets() },
    });
    expect(result).toMatchObject({ ok: false, code: 'NODE_PK_MISMATCH' });
    expect(calls.filter((c) => c.kind === 'login-code')).toEqual([]);
  });

  test('首台不是 self 但证明本身被拒（TOTP_INVALID）：仍整次中止', async () => {
    const { api, calls } = fakeApi({
      issue: () => Response.json({ code: 'TOTP_INVALID' }, { status: 401 }),
    });
    const targets = planLoginCodeTargets([row(NODE_A), row(NODE_B)], 'all', SELF).targets;
    const result = await issueLoginCode({
      context: context(),
      targets,
      proof: { kind: 'totp', code: '000000' },
      api,
      now: NOW,
      deps: { readSecrets: () => rootSecrets() },
    });
    expect(result).toMatchObject({ ok: false, code: 'TOTP_INVALID' });
    expect(calls.filter((c) => c.kind === 'login-code').map((c) => c.nodeId)).toEqual([NODE_A]);
  });

  test('首台 TOTP_INVALID 整次中止，不再请求其余节点', async () => {
    const { api, calls } = fakeApi({
      issue: () => Response.json({ code: 'TOTP_INVALID' }, { status: 401 }),
    });
    const result = await issueLoginCode({
      context: context(),
      targets: TARGETS,
      proof: { kind: 'totp', code: '000000' },
      api,
      now: NOW,
      deps: { readSecrets: () => rootSecrets() },
    });
    expect(result).toMatchObject({ ok: false, code: 'TOTP_INVALID' });
    expect(result.nodes).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'login-code').map((c) => c.nodeId)).toEqual(['self']);
  });

  test('部分失败：命令只含成功节点，老节点 404 记为 OUTDATED', async () => {
    const { api } = fakeApi({
      issue: (nodeId) =>
        nodeId === NODE_B
          ? new Response('not found', { status: 404 })
          : Response.json(
              { expires_at: nodeId === 'self' ? NOW + 500_000 : NOW + 600_000 },
              {
                status: 201,
              }
            ),
    });
    const result = await issueLoginCode({
      context: context(),
      targets: TARGETS,
      proof: { kind: 'totp', code: '123456' },
      api,
      now: NOW,
      deps: { readSecrets: () => rootSecrets() },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parts = decodeLoginCode(result.handle.command.slice('vibeterm login --code '.length));
    expect(parts?.nodeIds).toEqual([SELF, NODE_A]);
    expect(result.handle.meshIds).toEqual([SELF, NODE_A]);
    expect(result.handle.expiresAt).toBe(NOW + 500_000);
    expect(result.nodes.find((n) => n.meshId === NODE_B)).toMatchObject({
      ok: false,
      code: 'OUTDATED',
    });
    disposeLoginCode(result.handle);
  });

  test('密码证明：临时会话钥用完清零，entry 用 mode.nodeId，不碰全局会话', async () => {
    const { api, calls } = fakeApi();
    const pair = generateEd25519KeyPair();
    const result = await issueLoginCode({
      context: context(),
      targets: TARGETS.slice(0, 1),
      proof: { kind: 'password', password: 'pw', totpCode: '654321' },
      api,
      now: NOW,
      deps: {
        deriveSeed: async () => fill(32, 0x11),
        generateSessionKeyPair: () => pair,
        readSecrets: () => {
          throw new Error('global session must not be read');
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(pair.secretKey.every((byte) => byte === 0)).toBe(true);
    const issue = calls.find((c) => c.kind === 'login-code');
    expect((issue?.body.totp as { code: string }).code).toBe('654321');
    const login = decodeLogin(decodeBase64url(String(issue?.body.login)));
    expect(login.entry).toBe(SELF);
    expect(login.target).toBe('self');
    if (result.ok) disposeLoginCode(result.handle);
  });

  test('查询 / 作废按节点派生码；销毁后不再发请求、状态为 unknown', async () => {
    const { api, calls } = fakeApi({ state: 'used' });
    const result = await issueLoginCode({
      context: context(),
      targets: TARGETS.slice(0, 2),
      proof: { kind: 'totp', code: '123456' },
      api,
      now: NOW,
      deps: { readSecrets: () => rootSecrets() },
    });
    if (!result.ok) throw new Error('issue failed');
    const parts = decodeLoginCode(result.handle.command.slice('vibeterm login --code '.length));
    expect(await pollLoginCodeStates(result.handle)).toEqual({ [SELF]: 'used', [NODE_A]: 'used' });
    await revokeLoginCode(result.handle);
    const revokes = calls.filter((c) => c.kind === 'login-code/revoke');
    expect(revokes.find((c) => c.nodeId === NODE_A)?.body.code).toBe(
      encodeBase64url(deriveNodeLoginCode(parts!.secret, NODE_A))
    );

    disposeLoginCode(result.handle);
    const before = calls.length;
    expect(await pollLoginCodeStates(result.handle)).toEqual({
      [SELF]: 'unknown',
      [NODE_A]: 'unknown',
    });
    await revokeLoginCode(result.handle);
    expect(calls.length).toBe(before);
  });
});
