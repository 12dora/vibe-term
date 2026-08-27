// 浏览器临时钥（sk_sess）与 delegation 的纯内存持有者。
//
// 设计约束（docs/hub/2026082700-hub-node-architecture.md §2）：
//   * sk_sess / delegation / k_totp **只在内存**，页面关闭即失，绝不写 localStorage 或 cookie。
//   * seed（= 根钥私钥）在派生出根钥与 k_totp 之后立即清零，根钥对象随即丢弃。
//   * sk_sess 只能签 login，不得签任何 user_key_log 记录。
//   * TOTP 只在 delegation.method === 'root' 且用户开了 TOTP 时随登录下发。

import type { AuthApi, MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { startAuthentication } from '@tmex/api-client/auth/index';
import type { Delegation } from '@tmex/shared/auth';
import {
  buildLogin,
  buildPasskeyDelegation,
  bytesEqual,
  createDelegation,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeDelegation,
  encodeLogin,
  encodePasskeyAssertion,
  generateEd25519KeyPair,
  rootKeyFromSeed,
  signLogin,
} from '@tmex/shared/auth';

export type SessionKeyMethod = 'root' | 'passkey';

/** 对外可见的会话钥元数据（不含任何私钥字节）。 */
export interface SessionKeyInfo {
  uid: string;
  /** 当前 entry 的 nodeId，写进 `login.entry`。 */
  entryNodeId: string;
  method: SessionKeyMethod;
  issuedAt: number;
  expiresAt: number;
  hasTotp: boolean;
  credentialId: string | null;
}

interface SessionKeySecrets {
  info: SessionKeyInfo;
  sessSk: Uint8Array;
  sessPk: Uint8Array;
  delegation: Delegation;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
  kTotp: Uint8Array | null;
  totpCode: string | null;
}

export type LoginFailureCode =
  | 'NO_SESSION_KEY'
  | 'UNKNOWN_NODE'
  | 'NODE_PK_MISMATCH'
  | 'TOTP_REQUIRED'
  | 'NETWORK_ERROR'
  | (string & {});

export type LoginNodeResult = { ok: true } | { ok: false; code: LoginFailureCode };

export type NodeLoginStatus = 'idle' | 'pending' | 'ok' | 'error';

export interface NodeLoginProgress {
  nodeId: string;
  nodeName: string;
  status: NodeLoginStatus;
  code?: LoginFailureCode;
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let current: SessionKeySecrets | null = null;
let progress: NodeLoginProgress[] = [];

const stateListeners = new Set<() => void>();
const progressListeners = new Set<() => void>();

function notifyState(): void {
  for (const listener of [...stateListeners]) listener();
}

function notifyProgress(): void {
  for (const listener of [...progressListeners]) listener();
}

export function subscribeSessionKey(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function subscribeLoginProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/** 纯快照（React `useSyncExternalStore` 用）：过期即视为不存在，但不做副作用。 */
export function getSessionKeySnapshot(): SessionKeyInfo | null {
  if (!current) return null;
  return Date.now() >= current.info.expiresAt ? null : current.info;
}

/** 命令式读取：顺带清掉已过期的会话钥。 */
export function getSessionKey(): SessionKeyInfo | null {
  if (!current) return null;
  if (Date.now() >= current.info.expiresAt) {
    clearSessionKey();
    return null;
  }
  return current.info;
}

export function hasSessionKey(): boolean {
  return getSessionKey() !== null;
}

export function getLoginProgress(): NodeLoginProgress[] {
  return progress;
}

function wipe(bytes: Uint8Array | null | undefined): void {
  bytes?.fill(0);
}

export function clearSessionKey(): void {
  if (!current) return;
  wipe(current.sessSk);
  wipe(current.delegationSig);
  wipe(current.kTotp);
  current.totpCode = null;
  current = null;
  notifyState();
}

/** fan-out 结束后清掉一次性的 TOTP 码；k_totp 保留供后续新 node 登录时配合新码使用。 */
export function clearTotpCode(): void {
  if (current) current.totpCode = null;
}

export function setTotpCode(code: string): void {
  if (current) current.totpCode = code;
}

// ---------------------------------------------------------------------------
// 建立会话钥
// ---------------------------------------------------------------------------

export interface EstablishFromSeedOptions {
  uid: string;
  entryNodeId: string;
  rootEpoch: number;
  hasTotp: boolean;
  totpCode?: string;
  now?: number;
}

/**
 * 由 seed（argon2id 输出）建立会话钥。
 * **调用后 `seed` 会被清零**——调用方不得再使用该数组。
 */
export function establishSessionFromSeed(
  seed: Uint8Array,
  opts: EstablishFromSeedOptions
): SessionKeyInfo {
  const now = opts.now ?? Date.now();
  const rootKey = rootKeyFromSeed(seed);
  const sess = generateEd25519KeyPair();
  const signed = createDelegation(rootKey, { uid: opts.uid, sessPk: sess.publicKey, now });
  const kTotp = opts.hasTotp ? deriveTotpKey(seed, opts.uid, opts.rootEpoch) : null;

  // 根钥用完即弃：清零我们持有的 seed 与 rootKey 内部副本。
  wipe(seed);
  wipe(rootKey.seed);

  clearSessionKey();
  current = {
    info: {
      uid: opts.uid,
      entryNodeId: opts.entryNodeId,
      method: 'root',
      issuedAt: Number(signed.delegation.issued_at),
      expiresAt: Number(signed.delegation.exp),
      hasTotp: opts.hasTotp,
      credentialId: null,
    },
    sessSk: sess.secretKey,
    sessPk: sess.publicKey,
    delegation: signed.delegation,
    delegationBytes: signed.bytes,
    delegationSig: signed.sig,
    kTotp,
    totpCode: opts.totpCode ?? null,
  };
  notifyState();
  return current.info;
}

export interface EstablishFromPasswordOptions extends EstablishFromSeedOptions {
  password: string;
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
}

export async function establishSessionFromPassword(
  opts: EstablishFromPasswordOptions
): Promise<SessionKeyInfo> {
  const seed = await deriveSeed(opts.password, {
    salt: decodeBase64url(opts.kdfParams.salt),
    memory_kib: opts.kdfParams.memory_kib,
    iterations: opts.kdfParams.iterations,
    parallelism: opts.kdfParams.parallelism,
  });
  return establishSessionFromSeed(seed, opts);
}

export interface EstablishFromPasskeyOptions {
  uid: string;
  entryNodeId: string;
  /** 指定用哪一把；不给则用 entry 下发的 allowCredentials 里的第一把。 */
  credentialId?: string;
  api?: AuthApi;
  now?: number;
}

export class PasskeyCredentialUnknownError extends Error {
  readonly code = 'PASSKEY_CREDENTIAL_UNKNOWN';
  constructor() {
    super('no passkey credential available for this entry');
    this.name = 'PasskeyCredentialUnknownError';
  }
}

/**
 * passkey 路径：delegation 里必须先写死 credential_id（challenge = sha256(borsh(delegation))），
 * 而凭证列表只有 entry 知道——所以先用一个探测 delegation 换回 `allowCredentials`，
 * 选定凭证后再用最终 delegation 换一次 options，仪式只做一次。
 * 断言整体以 Borsh `PasskeyAssertion` 编码作为 `delegation_sig`。
 */
export async function establishSessionFromPasskey(
  opts: EstablishFromPasskeyOptions
): Promise<SessionKeyInfo> {
  const api = opts.api ?? defaultAuthApi;
  const now = opts.now ?? Date.now();
  const sess = generateEd25519KeyPair();

  const buildFor = (credentialId: string) =>
    buildPasskeyDelegation({ uid: opts.uid, sessPk: sess.publicKey, now, credentialId });

  let credentialId = opts.credentialId ?? '';
  let delegation = buildFor(credentialId);
  let options = await api.passkeyLoginOptions(
    opts.uid,
    encodeBase64url(encodeDelegation(delegation))
  );
  if (!credentialId) {
    credentialId = options.allowCredentials?.[0]?.id ?? '';
    if (!credentialId) throw new PasskeyCredentialUnknownError();
    delegation = buildFor(credentialId);
    options = await api.passkeyLoginOptions(
      opts.uid,
      encodeBase64url(encodeDelegation(delegation))
    );
  }
  // 只允许用 delegation 里绑定的那把凭证，否则断言与 credential_id 对不上。
  const assertion = await startAuthentication({
    ...options,
    allowCredentials: [{ id: credentialId }],
  });
  if (assertion.id !== credentialId) {
    throw new Error('passkey assertion credential mismatch');
  }

  const delegationBytes = encodeDelegation(delegation);
  const delegationSig = encodePasskeyAssertion({
    credential_id: assertion.id,
    client_data_json: decodeBase64url(assertion.response.clientDataJSON),
    authenticator_data: decodeBase64url(assertion.response.authenticatorData),
    signature: decodeBase64url(assertion.response.signature),
  });

  clearSessionKey();
  current = {
    info: {
      uid: opts.uid,
      entryNodeId: opts.entryNodeId,
      method: 'passkey',
      issuedAt: Number(delegation.issued_at),
      expiresAt: Number(delegation.exp),
      hasTotp: false,
      credentialId,
    },
    sessSk: sess.secretKey,
    sessPk: sess.publicKey,
    delegation,
    delegationBytes,
    delegationSig,
    kTotp: null,
    totpCode: null,
  };
  notifyState();
  return current.info;
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

export interface LoginToNodeOptions {
  api?: AuthApi;
  /** 已知的 node 行（避免 fan-out 时每个 node 各拉一次列表）。 */
  node?: MeshNode;
}

/**
 * 对单台 node 执行设计 §2「登录」的 1–3 步。
 * 第 1 步拿到的 `nodePk` 必须与 `/api/mesh/nodes` 中该 node 的公钥一致，
 * 否则（失陷 hub 掉包公钥）立即中止，不签任何东西。
 */
export async function loginToNode(
  nodeId: string,
  opts: LoginToNodeOptions = {}
): Promise<LoginNodeResult> {
  const session = getSessionKey();
  if (!current || !session) return { ok: false, code: 'NO_SESSION_KEY' };
  const api = opts.api ?? defaultAuthApi;

  let node = opts.node;
  if (!node) {
    try {
      node = (await api.listNodes()).find((item) => item.id === nodeId);
    } catch {
      return { ok: false, code: 'NETWORK_ERROR' };
    }
  }
  if (!node) return { ok: false, code: 'UNKNOWN_NODE' };

  const needsTotp = session.method === 'root' && session.hasTotp;
  if (needsTotp && !(current.kTotp && current.totpCode)) {
    return { ok: false, code: 'TOTP_REQUIRED' };
  }

  let challenge: Awaited<ReturnType<AuthApi['challenge']>>;
  try {
    challenge = await api.challenge(nodeId, session.uid);
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }

  const targetPk = decodeBase64url(challenge.nodePk);
  if (!bytesEqual(targetPk, decodeBase64url(node.publicKey))) {
    return { ok: false, code: 'NODE_PK_MISMATCH' };
  }

  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: nodeId,
    targetPk,
    uid: session.uid,
    entry: session.entryNodeId,
  });
  const sig = signLogin(current.sessSk, login);

  try {
    const result = await api.login(nodeId, {
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(sig),
      delegation: encodeBase64url(current.delegationBytes),
      delegation_sig: encodeBase64url(current.delegationSig),
      ...(needsTotp && current.kTotp && current.totpCode
        ? { totp: { code: current.totpCode, k_totp: encodeBase64url(current.kTotp) } }
        : {}),
    });
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }
}

function setProgress(next: NodeLoginProgress[]): void {
  progress = next;
  notifyProgress();
}

function patchProgress(nodeId: string, patch: Partial<NodeLoginProgress>): void {
  setProgress(progress.map((row) => (row.nodeId === nodeId ? { ...row, ...patch } : row)));
}

export interface FanOutOptions {
  api?: AuthApi;
  /** 已登录的 node 是否跳过，默认跳过。 */
  skipLoggedIn?: boolean;
}

/**
 * 对 `/api/mesh/nodes` 中当前在线的每个 node 并行执行登录，进度写入 progress store。
 * 完成后清掉一次性 TOTP 码。
 */
export async function loginToAllReachable(opts: FanOutOptions = {}): Promise<NodeLoginProgress[]> {
  const api = opts.api ?? defaultAuthApi;
  const skipLoggedIn = opts.skipLoggedIn ?? true;

  let nodes: MeshNode[];
  try {
    nodes = await api.listNodes();
  } catch {
    setProgress([]);
    return [];
  }

  const targets = nodes.filter((node) => node.online && !(skipLoggedIn && node.loggedIn));
  setProgress(
    targets.map((node) => ({ nodeId: node.id, nodeName: node.name, status: 'pending' as const }))
  );

  await Promise.all(
    targets.map(async (node) => {
      const result = await loginToNode(node.id, { api, node });
      patchProgress(node.id, result.ok ? { status: 'ok' } : { status: 'error', code: result.code });
    })
  );

  clearTotpCode();
  return progress;
}

/** 全部登出：对每台 node fan-out `POST /n/:T/api/auth/logout`，随后丢弃会话钥。 */
export async function logoutEverywhere(opts: { api?: AuthApi } = {}): Promise<void> {
  const api = opts.api ?? defaultAuthApi;
  let nodes: MeshNode[] = [];
  try {
    nodes = await api.listNodes();
  } catch {
    nodes = [];
  }
  await Promise.all(
    nodes.filter((node) => node.loggedIn).map((node) => api.logout(node.id).catch(() => undefined))
  );
  clearSessionKey();
  setProgress([]);
}
