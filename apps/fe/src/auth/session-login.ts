// 会话钥的建立与登录签名实现：argon2id 派生、Ed25519 delegation/login 签名、passkey 仪式。
// 这些依赖（hash-wasm、@noble/curves、WebAuthn 客户端）都只在用户真的登录时才用到，
// 因此本模块**不进常驻路径**——`session-key-store.ensureNodeLogin()` 与登录页各自按需加载。

import { SELF_NODE_ID } from '@tmex/api-client';
import type {
  AuthApi,
  MeshNode,
  PasskeySummary,
  PublicKeyCredentialDescriptorJSON,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi, startAuthentication } from '@tmex/api-client/auth/index';
import type { Login } from '@tmex/shared/auth';
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
  generateWebCryptoEd25519KeyPair,
  rootKeyFromSeed,
  signLogin,
  signWithWebCryptoEd25519,
} from '@tmex/shared/auth';

import { markLoggedIn } from '@/node/mesh-nodes';
import type { LoginNodeResult, SessionKeyInfo, SessionKeySecrets } from './session-key-store';
import {
  adoptSessionSecrets,
  clearSessionKey,
  clearTotpCode,
  getSessionKey,
  readSessionSecrets,
} from './session-key-store';

// ---------------------------------------------------------------------------
// 会话密钥材料
// ---------------------------------------------------------------------------

interface SessionKeyMaterial {
  publicKey: Uint8Array;
  /** WebCrypto 路径的不可导出私钥。 */
  cryptoKey: CryptoKey | null;
  /** `@noble` 回退路径的原始私钥。 */
  secretKey: Uint8Array | null;
  /** 没能交给 session store 时就地清零（只有 `@noble` 路径有字节要清）。 */
  destroy(): void;
}

/** WebCrypto 的 Ed25519 是否可用；不可用（老 Safari / 老 Chrome）探测一次就记住。 */
let webCryptoEd25519 = true;

/**
 * 生成 `sk_sess`。
 *
 * 首选 WebCrypto 的**不可导出**私钥：私钥字节从不进 JS，因而可以整把存进 IndexedDB，让 PWA
 * 冷启动后还能静默登录别的 node。不支持 Ed25519 的环境回退到 `@noble` 的原始私钥——那条路径
 * 只留内存，行为与改造前完全一致。
 */
async function generateSessionKeyMaterial(
  override?: () => { publicKey: Uint8Array; secretKey: Uint8Array }
): Promise<SessionKeyMaterial> {
  if (!override && webCryptoEd25519) {
    try {
      const pair = await generateWebCryptoEd25519KeyPair();
      return {
        publicKey: pair.publicKey,
        cryptoKey: pair.privateKey,
        secretKey: null,
        destroy: () => undefined,
      };
    } catch {
      webCryptoEd25519 = false;
    }
  }
  const pair = (override ?? generateEd25519KeyPair)();
  return {
    publicKey: pair.publicKey,
    cryptoKey: null,
    secretKey: pair.secretKey,
    destroy: () => pair.secretKey.fill(0),
  };
}

/** 两条私钥形态共用的 login 签名；输出都是标准 64 字节 Ed25519 签名，node 侧无差别。 */
function signSessionLogin(secrets: SessionKeySecrets, login: Login): Promise<Uint8Array> {
  if (secrets.sessKey) return signWithWebCryptoEd25519(secrets.sessKey, encodeLogin(login));
  if (!secrets.sessSk) return Promise.reject(new Error('session key material is gone'));
  return Promise.resolve(signLogin(secrets.sessSk, login));
}

// ---------------------------------------------------------------------------
// 建立会话钥
// ---------------------------------------------------------------------------

interface EstablishFromSeedOptions {
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
 *
 * 会话密钥材料先生成完再碰 seed：整段根钥操作是同步的，中间不留 await，seed 与根钥私钥
 * 在内存里的窗口不会因为改成 async 而变长。
 */
export async function establishSessionFromSeed(
  seed: Uint8Array,
  opts: EstablishFromSeedOptions
): Promise<SessionKeyInfo> {
  const now = opts.now ?? Date.now();
  const sess = await generateSessionKeyMaterial();
  const rootKey = rootKeyFromSeed(seed);
  const signed = createDelegation(rootKey, { uid: opts.uid, sessPk: sess.publicKey, now });
  const kTotp = opts.hasTotp ? deriveTotpKey(seed, opts.uid, opts.rootEpoch) : null;

  // 根钥用完即弃：清零我们持有的 seed 与 rootKey 内部副本。
  seed.fill(0);
  rootKey.seed.fill(0);

  return adoptSessionSecrets({
    info: {
      uid: opts.uid,
      entryNodeId: opts.entryNodeId,
      method: 'root',
      issuedAt: Number(signed.delegation.issued_at),
      expiresAt: Number(signed.delegation.exp),
      hasTotp: opts.hasTotp,
      credentialId: null,
    },
    sessKey: sess.cryptoKey,
    sessSk: sess.secretKey,
    sessPk: sess.publicKey,
    delegation: signed.delegation,
    delegationBytes: signed.bytes,
    delegationSig: signed.sig,
    kTotp,
    totpCode: opts.totpCode ?? null,
  });
}

interface EstablishFromPasswordOptions extends EstablishFromSeedOptions {
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
  return await establishSessionFromSeed(seed, opts);
}

interface EstablishFromPasskeyOptions {
  uid: string;
  entryNodeId: string;
  /** 指定用哪一把；不给则按当前 origin / RP 过滤后再选。 */
  credentialId?: string;
  api?: AuthApi;
  now?: number;
  /** 当前 origin（测试注入）；缺省读 `location.origin`。 */
  origin?: string;
  /** 已知的 passkey 元数据（含注册 origin）；缺省尝试 `GET /api/auth/passkeys`。 */
  passkeys?: PasskeySummary[] | null;
  /** 会话密钥对生成器（测试注入）：拿到同一把 `sk_sess` 才能断言失败时它被清零。 */
  generateSessionKeyPair?: () => { publicKey: Uint8Array; secretKey: Uint8Array };
}

class PasskeyCredentialUnknownError extends Error {
  readonly code = 'PASSKEY_CREDENTIAL_UNKNOWN';
  constructor() {
    super('no passkey credential available for this entry');
    this.name = 'PasskeyCredentialUnknownError';
  }
}

function currentOrigin(override?: string): string {
  if (override) return override;
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
}

/**
 * 凭证选择结果。
 *
 * - `bind`：已经能唯一确定凭证，直接写进 delegation，只做一次仪式；
 * - `browser`：**不由前端挑**，把这份列表原样交给 WebAuthn，让浏览器 / 认证器选；
 * - `none`：当前 origin 一把可用的都没有。
 */
type PasskeySelection =
  | { kind: 'bind'; credentialId: string }
  | { kind: 'browser'; allowCredentials: PublicKeyCredentialDescriptorJSON[] }
  | { kind: 'none' };

/**
 * 决定这次断言用哪把凭证。
 *
 * **绝不回退到 `allowCredentials[0]`**：用户在 node A、node B 各注册过 passkey 时，从 B 登录
 * 若 A 的凭证排在前面，盲取第一把会把仪式锁死在属于 A 的凭证上并以 `NotAllowedError` 失败
 * （见 F4-1 / F4-fix 评审 Major）。取而代之：
 *
 * - 有可信 origin 元数据（登录后的 `/api/auth/passkeys`）→ 只留 `origin` **精确相等**的，
 *   没有 rp_id 回退；一把也不剩就是 `none`。
 * - 没有元数据（登录前通常没有会话，拉不到列表）→ 交给浏览器：后端已按精确 origin 过滤过
 *   登录 options，列表里每一把都能用，由认证器决定用户手上到底有哪一把。
 *   只剩一把时退化成 `bind`（那不是「挑」，本来就只有一个候选），省掉一次探测仪式。
 */
export function selectPasskeyCredential(input: {
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  passkeys?: PasskeySummary[] | null;
  origin: string;
  preferredId?: string;
}): PasskeySelection {
  const rows = (input.allowCredentials ?? []).filter((row) => Boolean(row.id));
  if (rows.length === 0) return { kind: 'none' };
  if (input.preferredId) {
    return rows.some((row) => row.id === input.preferredId)
      ? { kind: 'bind', credentialId: input.preferredId }
      : { kind: 'none' };
  }

  const known = input.passkeys ?? null;
  if (known && known.length > 0) {
    const byId = new Map(known.map((row) => [row.credential_id, row]));
    const sameOrigin = rows.filter((row) => byId.get(row.id)?.origin === input.origin);
    if (sameOrigin.length === 1) return { kind: 'bind', credentialId: sameOrigin[0].id };
    if (sameOrigin.length > 1) return { kind: 'browser', allowCredentials: sameOrigin };
    // 有元数据但没有一把属于当前 origin：宁可报「本入口没有可用 passkey」，
    // 也不要拿别的 origin 的凭证去发起注定失败的仪式。
    if (rows.some((row) => byId.has(row.id))) return { kind: 'none' };
  }
  if (rows.length === 1) return { kind: 'bind', credentialId: rows[0].id };
  return { kind: 'browser', allowCredentials: rows };
}

/**
 * passkey 路径：delegation 里必须先写死 credential_id（challenge = sha256(borsh(delegation))），
 * 而凭证列表只有 entry 知道——所以先用一个探测 delegation 换回 `allowCredentials`，
 * 选定凭证后再用最终 delegation 换一次 options。
 * 断言整体以 Borsh `PasskeyAssertion` 编码作为 `delegation_sig`。
 *
 * 凭证由 `selectPasskeyCredential()` 决定，前端**不做**「取第一把」这种猜测。候选不唯一且没有
 * 可信 origin 元数据时（登录前多半如此），先把服务端那份 `allowCredentials` **原样**交给
 * WebAuthn 做一次探测仪式，由浏览器 / 认证器选出用户手上真正有的那把，再用它绑定最终
 * delegation 做正式仪式——协议要求 challenge 覆盖 credential_id，这一步换不掉。
 * 单候选（后端按精确 origin 过滤后的常态）只做一次仪式。
 *
 * `sk_sess` 从生成起就在 `try/finally` 里：用户取消仪式、options 请求失败、origin 选不出凭证，
 * 都会立刻清零，只有成功交给全局 session store 才转移所有权（见 F4-fix 评审 Minor）。
 */
export async function establishSessionFromPasskey(
  opts: EstablishFromPasskeyOptions
): Promise<SessionKeyInfo> {
  const api = opts.api ?? defaultAuthApi;
  const now = opts.now ?? Date.now();
  const sess = await generateSessionKeyMaterial(opts.generateSessionKeyPair);
  let owned = false;

  try {
    const buildFor = (credentialId: string) =>
      buildPasskeyDelegation({ uid: opts.uid, sessPk: sess.publicKey, now, credentialId });

    let credentialId = opts.credentialId ?? '';
    let delegation = buildFor(credentialId);
    let options = await api.passkeyLoginOptions(
      opts.uid,
      encodeBase64url(encodeDelegation(delegation))
    );
    if (!credentialId) {
      // 登录前通常没有会话，`/api/auth/passkeys` 会失败——那时只能信后端的 origin 过滤。
      let passkeys = opts.passkeys ?? null;
      if (passkeys === null && opts.passkeys === undefined) {
        passkeys = await api.listPasskeys().catch(() => null);
      }
      const selection = selectPasskeyCredential({
        allowCredentials: options.allowCredentials,
        passkeys,
        origin: currentOrigin(opts.origin),
      });
      if (selection.kind === 'none') throw new PasskeyCredentialUnknownError();
      if (selection.kind === 'browser') {
        // 探测仪式：列表原样下发，浏览器选谁我们就绑谁。这份断言签的是探测 delegation
        // （credential_id 为空），服务端一定拒绝，拿来当凭证也没用。
        const probe = await startAuthentication({
          ...options,
          allowCredentials: selection.allowCredentials,
        });
        credentialId = probe.id;
      } else {
        credentialId = selection.credentialId;
      }
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

    const info = adoptSessionSecrets({
      info: {
        uid: opts.uid,
        entryNodeId: opts.entryNodeId,
        method: 'passkey',
        issuedAt: Number(delegation.issued_at),
        expiresAt: Number(delegation.exp),
        hasTotp: false,
        credentialId,
      },
      sessKey: sess.cryptoKey,
      sessSk: sess.secretKey,
      sessPk: sess.publicKey,
      delegation,
      delegationBytes: encodeDelegation(delegation),
      delegationSig: encodePasskeyAssertion({
        credential_id: assertion.id,
        client_data_json: decodeBase64url(assertion.response.clientDataJSON),
        authenticator_data: decodeBase64url(assertion.response.authenticatorData),
        signature: decodeBase64url(assertion.response.signature),
      }),
      kTotp: null,
      totpCode: null,
    });
    // 所有权已交给 session store（`clearSessionKey()` 负责它的清零）。
    owned = true;
    return info;
  } finally {
    if (!owned) sess.destroy();
  }
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

interface LoginToNodeOptions {
  api?: AuthApi;
  /** 已知的 node 行（避免 fan-out 时每个 node 各拉一次列表）。 */
  node?: MeshNode;
  /**
   * entry 自身的第一次登录：`/api/mesh/nodes` 需要会话，此时还拿不到自己的公钥，
   * 只能先登录、再用新会话拉列表回头核对（`verifySelfPublicKey`）。仅 `self` 允许。
   */
  selfBootstrap?: boolean;
}

/** self bootstrap 登录时用过的 nodePk，登录后必须与 mesh 列表里的公钥核对。 */
let selfChallengePk: Uint8Array | null = null;

/** 需要 TOTP 但码不在内存里 → null（回 TOTP_REQUIRED，一个请求都不发）；不需要 TOTP → undefined。 */
function resolveTotp(session: SessionKeyInfo) {
  if (session.method !== 'root' || !session.hasTotp) return undefined;
  const secrets = readSessionSecrets();
  if (!secrets?.kTotp || !secrets.totpCode) return null;
  return { code: secrets.totpCode, k_totp: encodeBase64url(secrets.kTotp) };
}

const pinnedPkOk = (targetPk: Uint8Array, node: MeshNode | undefined): boolean =>
  !node || bytesEqual(targetPk, decodeBase64url(node.publicKey));

/**
 * 对单台 node 执行设计 §2「登录」的 1–3 步。
 * 第 1 步拿到的 `nodePk` 必须与 `/api/mesh/nodes` 中该 node 的公钥一致，
 * 否则（失陷 hub 掉包公钥）立即中止，不签任何东西。
 */
export async function loginToNode(
  nodeId: string,
  { api = defaultAuthApi, node: knownNode, selfBootstrap }: LoginToNodeOptions = {}
): Promise<LoginNodeResult> {
  const session = getSessionKey();
  const secrets = readSessionSecrets();
  if (!secrets || !session) return { ok: false, code: 'NO_SESSION_KEY' };

  let node = knownNode;
  if (!node && !(selfBootstrap && nodeId === SELF_NODE_ID)) {
    const nodes = await api.listNodes().catch(() => null);
    if (!nodes) return { ok: false, code: 'NETWORK_ERROR' };
    node = nodes.find((item) => item.id === nodeId);
    if (!node) return { ok: false, code: 'UNKNOWN_NODE' };
  }

  const totp = resolveTotp(session);
  if (totp === null) return { ok: false, code: 'TOTP_REQUIRED' };

  const challenge = await api.challenge(nodeId, session.uid).catch(() => null);
  if (!challenge) return { ok: false, code: 'NETWORK_ERROR' };

  const targetPk = decodeBase64url(challenge.nodePk);
  if (!pinnedPkOk(targetPk, node)) return { ok: false, code: 'NODE_PK_MISMATCH' };
  if (!node) selfChallengePk = targetPk;

  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: nodeId,
    targetPk,
    uid: session.uid,
    entry: session.entryNodeId,
  });
  const body = {
    login: encodeBase64url(encodeLogin(login)),
    sig: encodeBase64url(await signSessionLogin(secrets, login)),
    delegation: encodeBase64url(secrets.delegationBytes),
    delegation_sig: encodeBase64url(secrets.delegationSig),
    totp,
  };
  const result = await api.login(nodeId, body).catch(() => null);
  if (!result) return { ok: false, code: 'NETWORK_ERROR' };
  return result.ok ? { ok: true } : { ok: false, code: result.code };
}

interface LoginSelfOptions {
  api?: AuthApi;
}

/**
 * 只登录 entry 自身（`self`），登录成功即可进入本机 UI。
 *
 * 仍然要拉一次 `/api/mesh/nodes`：mesh 列表里的 `publicKey` 来自 hub 签发的证书，而第 1 步
 * challenge 里的 `nodePk` 来自这台机器当场持有的钥，两者必须一致——entry 出示的不是被签发过
 * 的那把钥时（掉包 / 配置错乱）立刻丢弃会话钥，不让用户带着一个不可信的会话继续。
 * 这一次请求也是唯一挡在跳转前面的等待，**不做任何 fan-out**：其余 node 由
 * `ensureNodeLogin()` 在真正用到时再登录。
 */
export async function loginSelf(opts: LoginSelfOptions = {}): Promise<LoginNodeResult> {
  const api = opts.api ?? defaultAuthApi;
  const selfResult = await loginToNode(SELF_NODE_ID, { api, selfBootstrap: true });
  if (!selfResult.ok) {
    clearTotpCode();
    return selfResult;
  }

  const nodes = await api.listNodes().catch(() => null);
  // 一次性 TOTP 码用完即弃：它只在 ±30s 内有效，留着也救不了后面的懒登录，
  // 而 k_totp（服务端 TOTP 密文的解密钥）保留在内存里，用户下次输入新码时直接可用。
  clearTotpCode();
  if (!nodes) return { ok: false, code: 'NODE_LIST_FAILED' };

  const entryNodeId = readSessionSecrets()?.info.entryNodeId;
  const selfRow = nodes.find((node) => node.id === entryNodeId);
  const pinnedPk = selfChallengePk;
  selfChallengePk = null;
  if (pinnedPk && !pinnedPkOk(pinnedPk, selfRow)) {
    // 调用方据此退回登录页：等盘上那份真的删掉再返回，否则刷新一下会话钥又回来了。
    await clearSessionKey();
    return { ok: false, code: 'NODE_PK_MISMATCH' };
  }

  markLoggedIn(SELF_NODE_ID);
  return { ok: true };
}
