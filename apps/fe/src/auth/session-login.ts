// 会话钥的建立与登录签名实现：argon2id 派生、Ed25519 delegation/login 签名、passkey 仪式。
// 这些依赖（hash-wasm、@noble/curves、WebAuthn 客户端）都只在用户真的登录时才用到，因此本模块**不进常驻路径**——`session-key-store.ensureNodeLogin()` 与登录页各自按需加载。

import { markLoggedIn } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import type {
  AuthApi,
  AuthChallengeResponse,
  MeshNode,
  PasskeySummary,
} from '@vibeterm/api-client/auth/index';
import { WebAuthnError, defaultAuthApi } from '@vibeterm/api-client/auth/index';
import type { RootKey } from '@vibeterm/shared/auth';
import {
  buildLogin,
  bytesEqual,
  createDelegation,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  encodeLogin,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { transportFailureCode, withRetryAfter } from './login-throttle';
import { clearLocalDeviceCaches } from './logout-local-caches';
import { buildPasskeyDelegationForKey, runPasskeySecondFactor } from './passkey-ceremony';
import {
  type SessionKeyMaterial,
  generateSessionKeyMaterial,
  signSessionLogin,
} from './session-key-material';
import {
  adoptSessionSecrets,
  clearSessionKey,
  clearTotpCode,
  getSessionKey,
  readSessionSecrets,
  replaceSessionKey,
  setPasskeyAssertion,
} from './session-key-store';
import type { LoginNodeResult, SessionKeyInfo, SessionKeySecrets } from './session-key-types';
import { loginWithPop } from './session-pop-login';

export { setPasskeyCeremonyForTest } from './passkey-ceremony';

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
  /** 会话密钥对生成器（测试注入）：拿到同一把 `sk_sess` 才能断言失败时它被清零。 */
  generateSessionKeyPair?: () => { publicKey: Uint8Array; secretKey: Uint8Array };
  /** k_totp 派生（测试注入）：用来构造 HKDF 抛错这条失败路径。 */
  deriveKTotp?: (seed: Uint8Array, uid: string, rootEpoch: number) => Uint8Array;
  /**
   * 这次密码登录要不要先做一次通行密钥断言。由 `shouldRunPasskeySecondFactor()` 决定：
   * 本 origin 有通行密钥就要做，但服务端策略为 `either` 且本次已带验证码时不做（验证码单独
   * 就能过第二步）。判错也不致命——服务端回 `PASSKEY_REQUIRED` 时 `loginToNode()` 会补做。
   */
  passkeySecondFactor?: boolean;
  api?: AuthApi;
  /** 当前 origin（测试注入）；缺省读 `location.origin`。 */
  origin?: string;
  /** 二次验证仪式即将弹出：UI 据此把状态切成「请完成通行密钥验证」。 */
  onPasskeyPrompt?: () => void;
}

/**
 * 由 seed（argon2id 输出）建立会话钥。
 * **调用后 `seed` 会被清零**——调用方不得再使用该数组，成功失败都一样。
 *
 * 会话密钥材料先生成完再碰 seed：整段根钥操作是同步的，中间不留 await，seed 与根钥私钥
 * 在内存里的窗口不会因为改成 async 而变长。
 *
 * 整段在 `try/finally` 里：会话钥生成失败、`createDelegation()` 抛（sess_pk 长度不对）、
 * HKDF 抛，都必须把 seed、根钥私钥与那把没交出去的 `sk_sess` 就地清零——所有权只有在
 * `adoptSessionSecrets()` 真的接手之后才转移给 session store（见评审 Major）。
 */
export async function establishSessionFromSeed(
  seed: Uint8Array,
  opts: EstablishFromSeedOptions
): Promise<SessionKeyInfo> {
  const now = opts.now ?? Date.now();
  let sess: SessionKeyMaterial | null = null;
  let rootKey: RootKey | null = null;
  let kTotp: Uint8Array | null = null;
  let owned = false;
  try {
    sess = await generateSessionKeyMaterial(opts.generateSessionKeyPair);
    rootKey = rootKeyFromSeed(seed);
    const signed = createDelegation(rootKey, { uid: opts.uid, sessPk: sess.publicKey, now });
    kTotp = opts.hasTotp
      ? (opts.deriveKTotp ?? deriveTotpKey)(seed, opts.uid, opts.rootEpoch)
      : null;
    // 根钥材料到此为止就没用了：二次验证仪式要等用户按指纹，可能是几十秒，
    // 绝不让 seed / 根钥私钥在这段时间里继续躺在内存。`finally` 里再清一次无妨。
    seed.fill(0);
    rootKey.seed.fill(0);
    rootKey = null;

    const passkey = opts.passkeySecondFactor
      ? await runPasskeySecondFactor({
          api: opts.api ?? defaultAuthApi,
          uid: opts.uid,
          delegationBytes: signed.bytes,
          origin: opts.origin,
          onPrompt: opts.onPasskeyPrompt,
        })
      : null;

    const info = adoptSessionSecrets({
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
      passkeyCredentialId: passkey?.credentialId ?? null,
      passkeySig: passkey?.sig ?? null,
      kTotp,
      totpCode: opts.totpCode ?? null,
    });
    owned = true;
    return info;
  } finally {
    // 根钥用完即弃：清零我们持有的 seed 与 rootKey 内部副本。
    seed.fill(0);
    rootKey?.seed.fill(0);
    if (!owned) {
      sess?.destroy();
      kTotp?.fill(0);
    }
  }
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

interface ResumeAfterPasswordChangeOptions extends EstablishFromPasswordOptions {
  api?: AuthApi;
}

/**
 * 改密（`rotate-root` / `rotate-root-keep`）之后接回会话：用新密码、新 kdf 参数与新 root_epoch
 * 重建 delegation，再登录一次 entry 换新的入口 cookie。
 *
 * 顺序不能反——记录追加成功之前服务端只认旧根钥，新 delegation 一定验不过。整段走
 * `replaceSessionKey()`：替换期间压住 401 触发的登录页跳转，新会话被接受才落盘。改密已让服务端撤销
 * 全部会话，失败时装回的旧会话同样是废的，由调用方清掉并回登录页（见 `finishPasswordChange`）。
 */
export async function resumeSessionAfterPasswordChange(
  opts: ResumeAfterPasswordChangeOptions
): Promise<LoginNodeResult> {
  return replaceSessionKey(
    async () => {
      await establishSessionFromPassword(opts);
      // 改密后重新登录同样要过通行密钥二次验证：`rotate-root-keep` 不会删掉已注册的通行密钥。
      return await loginSelf({ api: opts.api ?? defaultAuthApi, allowPasskeyPrompt: true });
    },
    (result) => result.ok
  );
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

export { selectPasskeyCredential } from './passkey-credential-select';

/**
 * passkey 路径：凭证选择与仪式见 `buildPasskeyDelegationForKey()`；断言整体以 Borsh
 * `PasskeyAssertion` 编码作为 `delegation_sig`。
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
    const { delegation, delegationBytes, delegationSig, credentialId } =
      await buildPasskeyDelegationForKey({
        api,
        uid: opts.uid,
        sessPk: sess.publicKey,
        now,
        credentialId: opts.credentialId,
        origin: opts.origin,
        passkeys: opts.passkeys,
      });

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
      delegationBytes,
      delegationSig,
      // passkey 直接登录本身就是通行密钥授权，不需要再叠一层二次验证。
      passkeyCredentialId: null,
      passkeySig: null,
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
  /**
   * 允许在服务端回 `PASSKEY_REQUIRED` 时当场补一次通行密钥仪式再重试一次。
   * 只有用户主动发起的登录能给 true；后台静默登录一律把码交回调用方，不弹系统仪式。
   */
  allowPasskeyPrompt?: boolean;
  /** 已在途的 challenge（与钥恢复 / 登录 chunk 并行）。重试必须另取。 */
  challenge?: Promise<AuthChallengeResponse>;
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

async function lookupLoginNode(
  api: AuthApi,
  nodeId: string,
  knownNode: MeshNode | undefined,
  selfBootstrap: boolean | undefined
): Promise<{ ok: true; node: MeshNode | undefined } | { ok: false; code: string }> {
  if (knownNode || (selfBootstrap === true && nodeId === SELF_NODE_ID)) {
    return { ok: true, node: knownNode };
  }
  const nodes = await api.listNodes().catch(() => null);
  if (!nodes) return { ok: false, code: 'NETWORK_ERROR' };
  const node = nodes.find((item) => item.id === nodeId);
  return node ? { ok: true, node } : { ok: false, code: 'UNKNOWN_NODE' };
}

async function retryLoginWithPasskey(
  first: LoginNodeResult,
  args: {
    api: AuthApi;
    session: SessionKeyInfo;
    secrets: SessionKeySecrets;
    allowPasskeyPrompt?: boolean;
    attempt: () => Promise<LoginNodeResult>;
  }
): Promise<LoginNodeResult> {
  if (first.ok || first.code !== 'PASSKEY_REQUIRED') return first;
  if (!args.allowPasskeyPrompt || args.secrets.passkeySig) return first;
  try {
    const passkey = await runPasskeySecondFactor({
      api: args.api,
      uid: args.session.uid,
      delegationBytes: args.secrets.delegationBytes,
    });
    if (!passkey) return { ok: false, code: 'NO_PASSKEY_FOR_ORIGIN' };
    setPasskeyAssertion(passkey.credentialId, passkey.sig);
  } catch (err) {
    return { ok: false, code: secondFactorFailureCode(err) };
  }
  return args.attempt();
}

/**
 * 对单台 node 执行设计 §2「登录」的 1–3 步。
 * 第 1 步拿到的 `nodePk` 必须与 `/api/mesh/nodes` 中该 node 的公钥一致，
 * 否则（失陷信令方掉包公钥）立即中止，不签任何东西。
 */
export async function loginToNode(
  nodeId: string,
  {
    api = defaultAuthApi,
    node: knownNode,
    selfBootstrap,
    allowPasskeyPrompt,
    challenge,
  }: LoginToNodeOptions = {}
): Promise<LoginNodeResult> {
  const session = getSessionKey();
  const secrets = readSessionSecrets();
  if (!secrets || !session) return { ok: false, code: 'NO_SESSION_KEY' };

  const totp = resolveTotp(session);
  if (totp === null) return { ok: false, code: 'TOTP_REQUIRED' };

  // challenge 与随后可能的 listNodes 并行：nonce 一次性，重试不能复用这份。
  const pendingChallenge = challenge ?? api.challenge(nodeId, session.uid);
  // 查找节点失败时 challenge 仍在飞，先兜住 rejection，否则会变成未处理的 Promise 拒绝
  void pendingChallenge.catch(() => undefined);
  const found = await lookupLoginNode(api, nodeId, knownNode, selfBootstrap);
  if (!found.ok) return found;

  const attempt = (prefetched?: Promise<AuthChallengeResponse>) =>
    signAndLogin({ api, nodeId, session, secrets, node: found.node, totp, challenge: prefetched });
  return retryLoginWithPasskey(await attempt(pendingChallenge), {
    api,
    session,
    secrets,
    allowPasskeyPrompt,
    attempt,
  });
}

/**
 * 补做二次验证失败时交回给调用方的码。
 * WebAuthn 仪式异常没有业务码，用户取消必须说成「已取消」，否则界面只会给一句「登录失败」。
 */
function secondFactorFailureCode(err: unknown): string {
  if (err instanceof WebAuthnError) {
    return err.code === 'aborted' ? 'PASSKEY_ABORTED' : 'PASSKEY_VERIFY_FAILED';
  }
  return (err as { code?: string } | null)?.code ?? 'PASSKEY_REQUIRED';
}

/** 单次「取 challenge → 签 login → POST /login」。重试时必须整套重来：nonce 是一次性的。 */
async function signAndLogin(args: {
  api: AuthApi;
  nodeId: string;
  session: SessionKeyInfo;
  secrets: SessionKeySecrets;
  node: MeshNode | undefined;
  totp: { code: string; k_totp: string } | undefined;
  challenge?: Promise<AuthChallengeResponse>;
}): Promise<LoginNodeResult> {
  const { api, nodeId, session, secrets, node, totp } = args;
  const challenge = await (args.challenge ?? api.challenge(nodeId, session.uid)).then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, code: transportFailureCode(err), err })
  );
  if (!challenge.ok) return withRetryAfter({ ok: false, code: challenge.code }, challenge.err);

  const targetPk = decodeBase64url(challenge.value.nodePk);
  if (!pinnedPkOk(targetPk, node)) return { ok: false, code: 'NODE_PK_MISMATCH' };
  if (!node) selfChallengePk = targetPk;

  const login = buildLogin({
    challengeId: challenge.value.challenge_id,
    nonce: decodeBase64url(challenge.value.nonce),
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
    // 断言与 delegation 同寿命：手上有就一直带着，其余 node 因此不必再弹仪式。
    passkey:
      secrets.passkeyCredentialId && secrets.passkeySig
        ? {
            credential_id: secrets.passkeyCredentialId,
            sig: encodeBase64url(secrets.passkeySig),
          }
        : undefined,
  };
  const result = await loginWithPop(api, nodeId, body, secrets).catch(() => null);
  if (!result) return { ok: false, code: 'NETWORK_ERROR' };
  return result.ok ? { ok: true } : withRetryAfter({ ok: false, code: result.code }, result);
}

interface LoginSelfOptions {
  api?: AuthApi;
  /** 用户主动发起的登录：允许在 `PASSKEY_REQUIRED` 时当场补一次通行密钥仪式。 */
  allowPasskeyPrompt?: boolean;
}

/**
 * 只登录 entry 自身（`self`），登录成功即可进入本机 UI。
 *
 * 仍然要拉一次 `/api/mesh/nodes`：mesh 列表里的 `publicKey` 来自节点证书，而第 1 步
 * challenge 里的 `nodePk` 来自这台机器当场持有的钥，两者必须一致——entry 出示的不是被签发过
 * 的那把钥时（掉包 / 配置错乱）立刻丢弃会话钥，不让用户带着一个不可信的会话继续。
 * 这一次请求也是唯一挡在跳转前面的等待，**不做任何 fan-out**：其余 node 由
 * `ensureNodeLogin()` 在真正用到时再登录。
 */
export async function loginSelf(opts: LoginSelfOptions = {}): Promise<LoginNodeResult> {
  const api = opts.api ?? defaultAuthApi;
  const selfResult = await loginToNode(SELF_NODE_ID, {
    api,
    selfBootstrap: true,
    allowPasskeyPrompt: opts.allowPasskeyPrompt,
  });
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
    // 公钥对不上＝对面换了身份，本地按 node 落盘的拓扑与设备快照全部不再可信。
    clearLocalDeviceCaches();
    return { ok: false, code: 'NODE_PK_MISMATCH' };
  }

  markLoggedIn(SELF_NODE_ID);
  return { ok: true };
}
