// 浏览器登录流程的 CLI 移植（apps/fe/src/auth/session-login.ts 去掉 WebAuthn 的那一半）：
//
//   GET /api/auth/mode → POST /api/auth/challenge → argon2id 根种子 → 临时会话密钥对
//   → 签 Delegation(method='root') + Login → POST /api/auth/login（可带 TOTP）
//
// 安全边界与浏览器完全一致：根种子只在内存里活到签完 delegation，之后立即清零；访问别的
// node 一律经 entry 的 `/n/<id>/…` 转发并用该 node 自己的会话 cookie，CLI 不碰本机 mesh 身份。

import type { AuthModeResponse, MeshNode } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  buildLogin,
  bytesEqual,
  createDelegation,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeLogin,
  generateEd25519KeyPair,
  rootKeyFromSeed,
  signLogin,
} from '@vibeterm/shared/auth';
import type { Delegation } from '@vibeterm/shared/auth';
import { AuthError, CliError, NetworkError } from './errors';
import type { HttpClient } from './http';

/**
 * 服务端的两步验证策略：`either` = 有效 TOTP 或本 origin 的通行密钥断言其一即可。
 * 旧节点不下发该字段（undefined），此时只能按 `totpEnabled` / `passkeySecondFactor` 推断。
 */
export type SecondFactorPolicy = NonNullable<AuthModeResponse['secondFactorPolicy']>;

export type AuthMode = AuthModeResponse;

/** 是否需要交 TOTP。`totpEnabled` 在场时是权威；缺失时按策略字段判断。 */
export function needsTotp(mode: AuthMode): boolean {
  if (mode.totpEnabled !== undefined) return mode.totpEnabled;
  const policy = mode.secondFactorPolicy;
  return policy === 'totp' || policy === 'either';
}

/** 读 `/api/auth/mode`；standalone 开放实例上这个路由不存在（404）。 */
export async function fetchAuthMode(http: HttpClient, nodeId: string): Promise<AuthMode | null> {
  const response = await http.fetch(nodeId, '/api/auth/mode');
  if (response.status === 404) return null;
  await http.assertOk(nodeId, response, '/api/auth/mode');
  return (await response.json()) as AuthMode;
}

/** 该 entry 是否需要登录。 */
export function requiresLogin(mode: AuthMode | null): boolean {
  return mode !== null && mode.mode !== 'none';
}

export interface SessionMaterial {
  uid: string;
  /** entry 自身的 node id：`login.entry` 必须填它。 */
  entryNodeId: string;
  sessPk: Uint8Array;
  sessSk: Uint8Array;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
  delegation: Delegation;
  /** TOTP 密文的解密钥；由根种子派生，永远备着（服务端要码时才随登录体一起发）。 */
  kTotp: Uint8Array | null;
  /** 用完即清零：会话私钥、k_totp。 */
  destroy(): void;
}

export interface BuildSessionOptions {
  password: string;
  mode: AuthMode;
  now?: number;
  generateSessionKeyPair?: () => { publicKey: Uint8Array; secretKey: Uint8Array };
}

function requireModeField<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new CliError(`auth mode is missing "${field}"; the entry may be too old`);
  }
  return value;
}

/**
 * 由密码建立会话材料。
 *
 * 根种子与根钥私钥在签完 delegation 之后立刻清零：后面登录每个 node 只用得到会话私钥。
 * 任何一步抛错都会把已经生成的秘密清零（见 finally）。
 */
export async function buildSessionMaterial(options: BuildSessionOptions): Promise<SessionMaterial> {
  const { mode } = options;
  const uid = requireModeField(mode.uid, 'uid');
  const kdf = requireModeField(mode.kdfParams, 'kdfParams');
  const rootEpoch = requireModeField(mode.rootEpoch, 'rootEpoch');
  const now = options.now ?? Date.now();

  const seed = await deriveSeed(options.password, {
    salt: decodeBase64url(kdf.salt),
    memory_kib: kdf.memory_kib,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
  });
  const pair = (options.generateSessionKeyPair ?? generateEd25519KeyPair)();
  let kTotp: Uint8Array | null = null;
  let owned = false;
  try {
    const rootKey = rootKeyFromSeed(seed);
    const signed = createDelegation(rootKey, { uid, sessPk: pair.publicKey, now });
    // **无条件**派生 k_totp：种子马上就要清零，而旧版本入口的 `/api/auth/mode` 既不下发
    // `totpEnabled` 也不下发 `secondFactorPolicy`，只有等它回 `TOTP_REQUIRED` 才知道要交码。
    // 那时再想派生已经来不及（种子没了），用户只会一遍遍重试直到把限流撞死。
    kTotp = deriveTotpKey(seed, uid, rootEpoch);
    rootKey.seed.fill(0);
    const material: SessionMaterial = {
      uid,
      entryNodeId: mode.nodeId,
      sessPk: pair.publicKey,
      sessSk: pair.secretKey,
      delegation: signed.delegation,
      delegationBytes: signed.bytes,
      delegationSig: signed.sig,
      kTotp,
      destroy() {
        pair.secretKey.fill(0);
        kTotp?.fill(0);
      },
    };
    owned = true;
    return material;
  } finally {
    seed.fill(0);
    if (!owned) {
      pair.secretKey.fill(0);
      kTotp?.fill(0);
    }
  }
}

export interface LoginNodeResult {
  nodeId: string;
  ok: boolean;
  code?: string;
  expiresAt?: number;
  /** challenge 里目标 node 出示的公钥（base64url）；调用方据此与 mesh 名册核对。 */
  nodePk?: string;
}

/** 本地就能判定的失败：会话材料里没有 k_totp，交了码也没用。 */
export const TOTP_KEY_UNAVAILABLE = 'TOTP_KEY_UNAVAILABLE';

interface ChallengeResponse {
  challenge_id: string;
  nonce: string;
  nodePk: string;
}

/** 一次「取 challenge → 签 login → POST /login」。重试必须整套重来：nonce 一次性。 */
export async function loginToNode(args: {
  http: HttpClient;
  nodeId: string;
  material: SessionMaterial;
  /** mesh 列表里的该 node 公钥（base64url）；给了就与 challenge 的 nodePk 逐字节核对。 */
  pinnedPublicKey?: string | null;
  totpCode?: string | null;
}): Promise<LoginNodeResult> {
  const { http, nodeId, material } = args;
  const challenge = await http.json<ChallengeResponse>(nodeId, 'POST', '/api/auth/challenge', {
    uid: material.uid,
  });

  const targetPk = decodeBase64url(challenge.nodePk);
  if (args.pinnedPublicKey && !bytesEqual(targetPk, decodeBase64url(args.pinnedPublicKey))) {
    // 失陷 hub 掉包目标公钥：立即中止，一个字节都不签。
    return { nodeId, ok: false, code: 'NODE_PK_MISMATCH' };
  }

  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: nodeId,
    targetPk,
    uid: material.uid,
    entry: material.entryNodeId,
  });
  const body: Record<string, unknown> = {
    login: encodeBase64url(encodeLogin(login)),
    sig: encodeBase64url(signLogin(material.sessSk, login)),
    delegation: encodeBase64url(material.delegationBytes),
    delegation_sig: encodeBase64url(material.delegationSig),
  };
  if (args.totpCode) {
    // 手上没有 k_totp 就别发了：服务端解不开 TOTP 密文，只会回 TOTP_INVALID 并计一次失败。
    if (!material.kTotp) return { nodeId, ok: false, code: TOTP_KEY_UNAVAILABLE };
    body.totp = { code: args.totpCode, k_totp: encodeBase64url(material.kTotp) };
  }

  const response = await http.fetch(nodeId, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) {
    const payload = (await response.json()) as { expires_at?: number };
    return { nodeId, ok: true, expiresAt: payload.expires_at, nodePk: challenge.nodePk };
  }
  return { nodeId, ok: false, code: await readLoginErrorCode(response), nodePk: challenge.nodePk };
}

async function readLoginErrorCode(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 非 JSON 体
  }
  return `HTTP_${response.status}`;
}

/** `/api/mesh/nodes`：standalone 入口没有这个路由，视为「只有 entry 自己」。 */
export async function listMeshNodes(http: HttpClient): Promise<MeshNode[]> {
  const response = await http.fetch(SELF_NODE_ID, '/api/mesh/nodes');
  if (response.status === 404) return [];
  if (response.status === 401) return [];
  if (!response.ok) {
    throw new NetworkError(`GET /api/mesh/nodes → HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { nodes?: MeshNode[] };
  return payload.nodes ?? [];
}

/** 登录失败码 → 面向用户的错误（退出码 3）。 */
export function loginFailure(nodeId: string, code: string, policy?: SecondFactorPolicy): CliError {
  if (code === 'TOTP_REQUIRED') {
    return new AuthError(
      `two-step verification is enabled for this account (node ${nodeId})`,
      'pass --totp <code>, set VIBETERM_TOTP, or run login from a terminal to be prompted',
      code
    );
  }
  if (code === TOTP_KEY_UNAVAILABLE) {
    return new AuthError(
      `cannot send a TOTP code to node ${nodeId}: the session material has no k_totp`,
      'run vibeterm login again so the code is derived together with the root seed',
      code
    );
  }
  if (code === 'TOTP_INVALID') {
    return new AuthError(
      `the TOTP code was rejected by node ${nodeId}`,
      'check the clock on both machines and try a fresh code',
      code
    );
  }
  if (code === 'PASSKEY_REQUIRED') {
    return new AuthError(
      `node ${nodeId} requires a passkey assertion for this entry origin, which the CLI cannot perform`,
      passkeyHint(policy),
      code
    );
  }
  if (code === 'PASSKEY_INVALID') {
    return new AuthError(`node ${nodeId} rejected the passkey assertion`, undefined, code);
  }
  if (code === 'INVALID_CREDENTIALS') {
    return new AuthError(`invalid username or password (node ${nodeId})`, undefined, code);
  }
  if (code === 'RATE_LIMITED') {
    return new AuthError(
      `node ${nodeId} is rate limiting login attempts; wait and retry`,
      undefined,
      code
    );
  }
  if (code === 'NODE_PK_MISMATCH') {
    return new AuthError(
      `node ${nodeId} presented a public key that does not match the mesh roster; aborting`,
      'the entry may be compromised or misconfigured; verify it before logging in again',
      code
    );
  }
  return new AuthError(`login to node ${nodeId} failed: ${code}`, undefined, code);
}

function passkeyHint(policy?: SecondFactorPolicy): string {
  if (policy === 'either') {
    return 'pass --totp <code> (or set VIBETERM_TOTP): a valid TOTP code satisfies the second factor';
  }
  if (policy === 'passkey') {
    return [
      'this account has no TOTP, so only a passkey can satisfy the second factor here.',
      'Enable two-step verification (vibeterm hub user totp <user>), sign in from a browser on this',
      'origin, or use an entry address with no passkey registered for it.',
    ].join(' ');
  }
  return [
    'enable two-step verification and pass --totp <code>: a TOTP code satisfies the second factor',
    'on entries that report secondFactorPolicy="either"; older entries require a browser passkey.',
  ].join(' ');
}
