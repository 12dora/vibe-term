// 登录命令接口测试的公共装配：直接构造 AuthRoutes，不经 MeshHttpRuntime。
import {
  buildLogin,
  buildPasskeyDelegation,
  createDelegation,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeDelegation,
  encodeLogin,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateEd25519KeyPair,
  sha256,
  signLogin,
  totpCode,
} from '@vibeterm/shared/auth';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { encodePasskeyAssertionSig } from '../auth/passkey';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService, kdfParamsFromJson } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { AuthRoutes } from './auth-routes';
import { SET_SESSION_HEADER, setMeshRequestContext } from './mesh-deps';

export const NODE_ID = 'ab'.repeat(16);
export const ENTRY_ID = 'cd'.repeat(16);
export const NODE_PK = new Uint8Array(32).fill(5);
export const PASSWORD = 'vibeterm-test';
export const MINUTE = 60_000;

export type Sess = ReturnType<typeof generateEd25519KeyPair>;

export async function boot() {
  let clock = Date.now();
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keyLogService = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore,
  });
  const user = await keyLogService.bootstrapUser({ username: 'alice', password: PASSWORD });
  const routes = new AuthRoutes({
    roles: { node: true, relay: false },
    nodeId: NODE_ID,
    nodePk: NODE_PK,
    userStore,
    keyLogService,
    challengeStore: new ChallengeStore({ now: () => clock }),
    nodeSessionStore,
    publisher: { publish() {} },
    now: () => clock,
    primaryUserId: user.userId,
    verifyDelegationPasskey: async () => true,
  });
  return {
    close,
    routes,
    userStore,
    keyLogService,
    nodeSessionStore,
    user,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

export type Mesh = Awaited<ReturnType<typeof boot>>;

export async function post(
  mesh: Mesh,
  path: string,
  body: unknown,
  opts?: { via?: string; cookie?: string }
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts?.cookie ? { cookie: opts.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  if (opts?.via) setMeshRequestContext(req, { via: opts.via });
  const res = await mesh.routes.handle(req);
  if (!res) throw new Error(`unhandled ${path}`);
  return res;
}

export async function enrollTotp(mesh: Mesh): Promise<{ secret: Uint8Array; kTotp: string }> {
  const state = mesh.keyLogService.currentState(mesh.user.userId);
  const record = mesh.userStore.getById(mesh.user.userId);
  if (!record) throw new Error('missing user');
  const secret = new Uint8Array(20).fill(7);
  const kTotp = deriveTotpKey(
    await deriveSeed(PASSWORD, kdfParamsFromJson(record.kdfParamsJson)),
    mesh.user.userId,
    state.rootEpoch
  );
  const payload = await encryptTotpSecret(kTotp, secret, {
    uid: mesh.user.userId,
    root_epoch: state.rootEpoch,
    seq: state.head.seq + 1n,
  });
  const applied = await mesh.keyLogService.signAndApply(mesh.user.userId, mesh.user.rootKey, {
    type: 'set-totp',
    payload: encodeSetTotpPayload(payload),
  });
  if (!applied.ok) throw new Error('set-totp failed');
  return { secret, kTotp: encodeBase64url(kTotp) };
}

export function currentCode(mesh: Mesh, secret: Uint8Array): string {
  return totpCode(secret, Math.floor(mesh.now() / 1000));
}

export type EnvelopeOpts = {
  purpose?: 'login-code';
  issuedAt?: number;
  sess?: Sess;
  totp?: { code: string; k_totp: string };
  via?: string;
  passkeyCredential?: string;
};

export async function envelope(mesh: Mesh, opts: EnvelopeOpts = {}) {
  const uid = mesh.user.userId;
  const sess = opts.sess ?? generateEd25519KeyPair();
  const issuedAt = opts.issuedAt ?? mesh.now();
  const ch = await post(
    mesh,
    '/api/auth/challenge',
    { uid, ...(opts.purpose ? { purpose: opts.purpose } : {}) },
    { via: opts.via }
  );
  if (ch.status !== 200) throw new Error(`challenge failed: ${ch.status}`);
  const chBody = (await ch.json()) as { challenge_id: string; nonce: string };
  let delegation: string;
  let delegationSig: string;
  if (opts.passkeyCredential) {
    const del = buildPasskeyDelegation({
      uid,
      sessPk: sess.publicKey,
      now: issuedAt,
      credentialId: opts.passkeyCredential,
    });
    delegation = encodeBase64url(encodeDelegation(del));
    delegationSig = encodeBase64url(
      encodePasskeyAssertionSig({
        id: opts.passkeyCredential,
        rawId: opts.passkeyCredential,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(new Uint8Array([1])),
          authenticatorData: encodeBase64url(new Uint8Array([2])),
          signature: encodeBase64url(new Uint8Array([3])),
        },
        clientExtensionResults: {},
      })
    );
  } else {
    const del = createDelegation(mesh.user.rootKey, {
      uid,
      sessPk: sess.publicKey,
      now: issuedAt,
    });
    delegation = encodeBase64url(del.bytes);
    delegationSig = encodeBase64url(del.sig);
  }
  const login = buildLogin({
    challengeId: chBody.challenge_id,
    nonce: decodeBase64url(chBody.nonce),
    target: NODE_ID,
    targetPk: NODE_PK,
    uid,
    entry: opts.via ?? 'self',
  });
  return {
    login: encodeBase64url(encodeLogin(login)),
    sig: encodeBase64url(signLogin(sess.secretKey, login)),
    delegation,
    delegation_sig: delegationSig,
    ...(opts.totp ? { totp: opts.totp } : {}),
  };
}

export function newCode(): { code: string; hash: string } {
  const nodeCode = crypto.getRandomValues(new Uint8Array(32));
  return { code: encodeBase64url(nodeCode), hash: encodeBase64url(sha256(nodeCode)) };
}

export async function issue(mesh: Mesh, opts: EnvelopeOpts = {}, code = newCode()) {
  const body = await envelope(mesh, { purpose: 'login-code', ...opts });
  const payload = { ...body, code_hash: code.hash };
  const res = await post(mesh, '/api/auth/login-code', payload, { via: opts.via });
  return { res, code };
}

export function redeem(
  mesh: Mesh,
  code: string,
  extra?: { pop?: boolean; via?: string; sess?: Sess }
) {
  const sess = extra?.sess ?? generateEd25519KeyPair();
  return post(
    mesh,
    '/api/auth/login-code/redeem',
    { code, sess_pk: encodeBase64url(sess.publicKey), ...(extra?.pop ? { pop: true } : {}) },
    { via: extra?.via }
  );
}

export async function statusOf(mesh: Mesh, code: string): Promise<string> {
  const res = await post(mesh, '/api/auth/login-code/status', { code });
  return ((await res.json()) as { state: string }).state;
}

export function sidOf(res: Response): string {
  return res.headers.get(SET_SESSION_HEADER.name)?.split(';')[0] ?? '';
}

export async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}
