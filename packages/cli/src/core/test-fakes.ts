// 各测试套共用的假件：一个实现 mode/challenge/login/logout 的内存网关。
// 仅供 *.test.ts 使用，不从包入口导出，也不进 bundle。

import {
  type KdfParams,
  decodeBase64url,
  decodeDelegation,
  decodeLogin,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  generateEd25519KeyPair,
  generateKdfParams,
  randomBytes,
  rootKeyFromSeed,
  totpCode,
  verifyDelegation,
  verifyLogin,
  verifyTotpCode,
} from '@vibeterm/shared/auth';
import { SET_SESSION_HEADER } from '@vibeterm/shared/http/mesh-headers';
import type { FetchLike } from './http';

export interface FakeUser {
  uid: string;
  username: string;
  password: string;
  rootEpoch: number;
  kdfParams: KdfParams;
  rootPublicKey: Uint8Array;
  /** 开了两步验证时的 TOTP 密钥（服务端侧明文，测试里不做 AEAD 封装）。 */
  totpSecret: Uint8Array | null;
  /** 客户端应当派生出的 k_totp（base64url）；登录时逐字比对。 */
  expectedKTotp: string;
}

export async function createFakeUser(options: {
  password: string;
  username?: string;
  uid?: string;
  rootEpoch?: number;
  totp?: boolean;
}): Promise<FakeUser> {
  // 单测里把 argon2 参数压到最低，否则每次登录都要 64 MiB / 3 轮。
  const kdfParams: KdfParams = { ...generateKdfParams(), memory_kib: 8, iterations: 1 };
  const seed = await deriveSeed(options.password, kdfParams);
  const rootKey = rootKeyFromSeed(seed);
  const uid = options.uid ?? 'u-1';
  const rootEpoch = options.rootEpoch ?? 0;
  return {
    uid,
    username: options.username ?? 'admin',
    password: options.password,
    rootEpoch,
    kdfParams,
    rootPublicKey: rootKey.publicKey,
    totpSecret: options.totp ? randomBytes(20) : null,
    expectedKTotp: encodeBase64url(deriveTotpKey(seed, uid, rootEpoch)),
  };
}

export interface FakeGatewayOptions {
  user: FakeUser;
  nodeId?: string;
  /** 额外 node（`/n/<id>/…`），值为该 node 的名字。 */
  nodes?: Record<string, string>;
  /** 服务端下发的二次验证策略。 */
  secondFactorPolicy?: 'either' | 'totp' | 'passkey' | 'none';
  /** 强制让 login 回这个码（模拟 PASSKEY_REQUIRED 等）。 */
  forceLoginError?: string;
  /** 只让某些 node 的 login 失败（键为 nodeId，`self` 表示 entry 自身）。 */
  forceLoginErrorFor?: Record<string, string>;
  /** 旧版本入口：`/api/auth/mode` 不下发 `totpEnabled` / `secondFactorPolicy`。 */
  omitTotpFields?: boolean;
  /** 名册里 entry 自己那行的公钥（base64url）；用来构造掉包公钥的场景。 */
  selfPublicKeyOverride?: string;
  /** 会话下发方式：内部头（entry 转发前）或 Set-Cookie（浏览器看到的形态）。 */
  sessionVia?: 'header' | 'cookie';
}

export interface FakeGateway {
  fetch: FetchLike;
  /** 收到的请求，按顺序。 */
  requests: Array<{ method: string; path: string; origin: string | null; cookie: string | null }>;
  /** 收到的每个登录体（按顺序），用来断言 `totp` / `k_totp` 真的发了。 */
  loginBodies: Array<{ nodeId: string; body: Record<string, unknown> }>;
  /** 已签发的会话：nodeId → sid。 */
  issued: Map<string, string>;
  /** 当前有效的 TOTP 码（没开两步验证时为 null）。 */
  currentTotp(): string | null;
}

interface Challenge {
  uid: string;
  nonce: Uint8Array;
  entryNodeId: string;
}

const SELF = 'self';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 目标 node：`/n/<id>/api/…` → `<id>`，其余 → `self`。 */
function splitNodePath(pathname: string): { nodeId: string; path: string } {
  const match = /^\/n\/([0-9a-f]{32})(\/.*)$/.exec(pathname);
  return match ? { nodeId: match[1], path: match[2] } : { nodeId: SELF, path: pathname };
}

/** 假网关的可变状态：各 handler 都是模块级函数，只认这一个对象。 */
interface GatewayState {
  options: FakeGatewayOptions;
  nodeId: string;
  nodeKeys: Map<string, ReturnType<typeof generateEd25519KeyPair>>;
  challenges: Map<string, Challenge>;
  issued: Map<string, string>;
  requests: FakeGateway['requests'];
  loginBodies: FakeGateway['loginBodies'];
  counter: number;
}

function keyFor(state: GatewayState, target: string) {
  const existing = state.nodeKeys.get(target);
  if (existing) return existing;
  const created = generateEd25519KeyPair();
  state.nodeKeys.set(target, created);
  return created;
}

function modeBody(state: GatewayState) {
  const { user, secondFactorPolicy } = state.options;
  return {
    mode: 'mesh' as const,
    nodeId: state.nodeId,
    uid: user.uid,
    username: user.username,
    kdfParams: {
      salt: encodeBase64url(user.kdfParams.salt),
      memory_kib: user.kdfParams.memory_kib,
      iterations: user.kdfParams.iterations,
      parallelism: user.kdfParams.parallelism,
    },
    passkeysForThisOrigin: false,
    passkeyAvailable: true,
    passkeySecondFactor: secondFactorPolicy === 'passkey',
    // 旧版本入口两个字段都不下发：客户端只能等服务端回 TOTP_REQUIRED 才知道要交码。
    ...(state.options.omitTotpFields
      ? {}
      : {
          secondFactorPolicy: secondFactorPolicy ?? (user.totpSecret ? 'totp' : 'none'),
          totpEnabled: user.totpSecret !== null,
        }),
    rootEpoch: user.rootEpoch,
    rootPublicKey: encodeBase64url(user.rootPublicKey),
  };
}

function meshNodeRow(state: GatewayState, id: string, name: string, keyId: string) {
  return {
    id,
    name,
    publicKey: encodeBase64url(keyFor(state, keyId).publicKey),
    online: true,
    reach: null,
    version: null,
    direct_capable: false,
    loggedIn: state.issued.has(keyId),
  };
}

function meshNodes(state: GatewayState) {
  const self = meshNodeRow(state, state.nodeId, 'entry', SELF);
  return {
    nodes: [
      state.options.selfPublicKeyOverride
        ? { ...self, publicKey: state.options.selfPublicKeyOverride }
        : self,
      ...Object.entries(state.options.nodes ?? {}).map(([id, name]) =>
        meshNodeRow(state, id, name, id)
      ),
    ],
  };
}

function forcedLoginError(state: GatewayState, target: string): string | null {
  return state.options.forceLoginErrorFor?.[target] ?? state.options.forceLoginError ?? null;
}

function issueSession(state: GatewayState, target: string): Response {
  state.counter += 1;
  const sid = `sid-${target}-${state.counter}`;
  state.issued.set(target, sid);
  const expiresAt = Date.now() + 3_600_000;
  if ((state.options.sessionVia ?? 'cookie') === 'cookie') {
    return json({ expires_at: expiresAt }, 200, {
      'set-cookie': `vibeterm_s_${target}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    });
  }
  return json({ expires_at: expiresAt }, 200, { [SET_SESSION_HEADER.name]: `${sid};3600` });
}

async function handleChallenge(
  state: GatewayState,
  target: string,
  request: Request
): Promise<Response> {
  const body = (await request.json()) as { uid?: string };
  const id = `c-${state.challenges.size + 1}`;
  const challenge: Challenge = {
    uid: body.uid ?? '',
    nonce: randomBytes(32),
    entryNodeId: target === SELF ? SELF : state.nodeId,
  };
  state.challenges.set(id, challenge);
  return json({
    challenge_id: id,
    nonce: encodeBase64url(challenge.nonce),
    nodePk: encodeBase64url(keyFor(state, target).publicKey),
  });
}

type LoginBody = Record<string, string | { code: string; k_totp: string }>;

/** 校验顺序与 gateway 的 handleLogin 一致：绑定 → delegation → login 签名 → 二次验证。 */
function verifyLoginEnvelope(state: GatewayState, target: string, body: LoginBody): string | null {
  const login = decodeLogin(decodeBase64url(body.login as string));
  const delegation = decodeDelegation(decodeBase64url(body.delegation as string));
  const challenge = state.challenges.get(login.challenge_id);
  if (!challenge) return 'CHALLENGE_CONSUMED';
  state.challenges.delete(login.challenge_id);

  const delegationOk = verifyDelegation(
    delegation,
    decodeBase64url(body.delegation_sig as string),
    {
      rootPublicKey: state.options.user.rootPublicKey,
      now: Date.now(),
    }
  );
  if (!delegationOk.ok) return 'INVALID_CREDENTIALS';
  if (login.uid !== delegation.uid || login.uid !== challenge.uid) return 'UID_MISMATCH';
  // 与 gateway 的 loginBindingError 同规则：本机 entry 允许填真实 node id。
  const selfEntry = challenge.entryNodeId === SELF && login.entry === state.nodeId;
  if (login.entry !== challenge.entryNodeId && !selfEntry) return 'ENTRY_MISMATCH';

  const verified = verifyLogin(login, decodeBase64url(body.sig as string), delegation.sess_pk, {
    challengeId: login.challenge_id,
    nonce: challenge.nonce,
    target: login.target,
    targetPk: keyFor(state, target).publicKey,
    uid: challenge.uid,
    entry: login.entry,
  });
  if (!verified.ok) return 'INVALID_CREDENTIALS';
  return checkTotp(state.options.user, body.totp);
}

async function handleLogin(
  state: GatewayState,
  target: string,
  request: Request
): Promise<Response> {
  const body = (await request.json()) as LoginBody;
  state.loginBodies.push({ nodeId: target, body });
  const forced = forcedLoginError(state, target);
  if (forced) return json({ code: forced }, 401);
  const failure = verifyLoginEnvelope(state, target, body);
  return failure ? json({ code: failure }, 401) : issueSession(state, target);
}

function handleAuthedPath(state: GatewayState, target: string, path: string): Response {
  if (!state.issued.has(target)) return json({ error: 'NODE_LOGIN_REQUIRED', nodeId: target }, 401);
  if (path === '/api/system/info') return json({ version: '2.0.8', node: target });
  if (path === '/api/devices') {
    return json({ devices: [{ id: 'd-1', name: 'laptop', type: 'local' }] });
  }
  if (path === '/api/mesh/nodes') return json(meshNodes(state));
  return json({ error: 'Not found' }, 404);
}

async function route(state: GatewayState, target: string, path: string, request: Request) {
  if (path === '/api/auth/mode') return json(modeBody(state));
  if (path === '/api/auth/challenge') return await handleChallenge(state, target, request);
  if (path === '/api/auth/login') return await handleLogin(state, target, request);
  if (path === '/api/auth/logout') {
    if (!state.issued.has(target)) return json({ error: 'UNAUTHORIZED' }, 401);
    state.issued.delete(target);
    return json({ ok: true });
  }
  // `/api/mesh/nodes` 永远按 entry 自身鉴权，与真实网关一致。
  return handleAuthedPath(state, path === '/api/mesh/nodes' ? SELF : target, path);
}

export function createFakeGateway(options: FakeGatewayOptions): FakeGateway {
  const state: GatewayState = {
    options,
    nodeId: options.nodeId ?? 'e'.repeat(32),
    nodeKeys: new Map(),
    challenges: new Map(),
    issued: new Map(),
    requests: [],
    loginBodies: [],
    counter: 0,
  };

  const fetchImpl: FetchLike = async (input, init) => {
    const request = new Request(input, init as RequestInit);
    const url = new URL(request.url);
    const { nodeId: target, path } = splitNodePath(url.pathname);
    state.requests.push({
      method: request.method,
      path: url.pathname,
      origin: request.headers.get('origin'),
      cookie: request.headers.get('cookie'),
    });
    return await route(state, target, path, request);
  };

  return {
    fetch: fetchImpl,
    requests: state.requests,
    loginBodies: state.loginBodies,
    issued: state.issued,
    currentTotp: () =>
      options.user.totpSecret
        ? totpCode(options.user.totpSecret, Math.floor(Date.now() / 1000))
        : null,
  };
}

function checkTotp(user: FakeUser, totp: unknown): string | null {
  if (!user.totpSecret) return null;
  if (typeof totp !== 'object' || totp === null) return 'TOTP_REQUIRED';
  const { code, k_totp } = totp as { code?: string; k_totp?: string };
  if (!code || !k_totp) return 'TOTP_REQUIRED';
  // 客户端派生的 k_totp 必须与服务端一致，否则真实网关连 TOTP 密文都解不开。
  if (k_totp !== user.expectedKTotp) return 'TOTP_INVALID';
  return verifyTotpCode(user.totpSecret, code, Math.floor(Date.now() / 1000))
    ? null
    : 'TOTP_INVALID';
}
