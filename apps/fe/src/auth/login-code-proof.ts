// 签发登录命令的身份证明材料：当前会话 + 新验证码 / 一次通行密钥仪式 / 现场输入密码。
// 后两种用临时会话钥，绝不交给全局 session store，也不落盘；用完由 `destroy()` 清零。

import type { AuthApi, AuthModeResponse } from '@vibeterm/api-client/auth/index';
import { WebAuthnError, requireRootEpoch } from '@vibeterm/api-client/auth/index';
import type { Login } from '@vibeterm/shared/auth';
import {
  createDelegation,
  decodeBase64url,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import {
  type PasskeySecondFactor,
  buildPasskeyDelegationForKey,
  runPasskeySecondFactor,
} from './passkey-ceremony';
import { shouldRunPasskeySecondFactor } from './second-factor';
import { generateSessionKeyMaterial, signSessionLogin } from './session-key-material';
import { readSessionSecrets } from './session-key-store';
import type { SessionKeySecrets } from './session-key-types';

export type LoginCodeProof =
  | { kind: 'totp'; code: string }
  | { kind: 'passkey' }
  | { kind: 'password'; password: string; totpCode?: string };

export interface LoginCodeProofMaterial {
  uid: string;
  /** 写进 `login.entry`：与同一把会话钥平时登录时填的值一致。 */
  entry: string;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
  totp?: { code: string; k_totp: string };
  passkey?: { credential_id: string; sig: string };
  sign(login: Login): Promise<Uint8Array>;
  destroy(): void;
}

export type LoginCodeProofResult =
  | { ok: true; material: LoginCodeProofMaterial }
  | { ok: false; code: string };

export interface LoginCodeProofDeps {
  api: AuthApi;
  now: number;
  readSecrets?: () => SessionKeySecrets | null;
  /** argon2id（测试注入）。 */
  deriveSeed?: (
    password: string,
    kdf: NonNullable<AuthModeResponse['kdfParams']>
  ) => Promise<Uint8Array>;
  generateSessionKeyPair?: () => { publicKey: Uint8Array; secretKey: Uint8Array };
  origin?: string;
}

interface ProofInput {
  mode: AuthModeResponse;
  selfMeshId: string;
}

/** 当前会话能否直接配一个新验证码签发：密码会话、带 k_totp、delegation 未过期、同一用户。 */
export function totpProofUsable(
  mode: AuthModeResponse,
  secrets: SessionKeySecrets | null,
  now: number
): secrets is SessionKeySecrets {
  if (!mode.totpEnabled || !secrets?.kTotp) return false;
  if (secrets.delegation.method !== 'root') return false;
  if (mode.uid && secrets.info.uid !== mode.uid) return false;
  return Number(secrets.delegation.exp) > now;
}

/** 准备证明时的异常 → 失败码：用户取消通行密钥仪式必须说成「已取消」。 */
export function proofFailureCode(err: unknown, fallback: string): string {
  if (err instanceof WebAuthnError) {
    return err.code === 'aborted' ? 'PASSKEY_CANCELLED' : 'PASSKEY_INVALID';
  }
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : fallback;
}

function encodeSecondFactor(passkey: PasskeySecondFactor | null) {
  return passkey
    ? { credential_id: passkey.credentialId, sig: encodeBase64url(passkey.sig) }
    : undefined;
}

async function maybeSecondFactor(
  input: ProofInput,
  deps: LoginCodeProofDeps,
  args: { uid: string; delegationBytes: Uint8Array; hasTotpCode: boolean }
): Promise<PasskeySecondFactor | null> {
  if (!shouldRunPasskeySecondFactor(input.mode, args.hasTotpCode)) return null;
  return runPasskeySecondFactor({
    api: deps.api,
    uid: args.uid,
    delegationBytes: args.delegationBytes,
    origin: deps.origin,
  });
}

async function totpProof(
  input: ProofInput,
  code: string,
  deps: LoginCodeProofDeps
): Promise<LoginCodeProofResult> {
  const secrets = (deps.readSecrets ?? readSessionSecrets)();
  if (!totpProofUsable(input.mode, secrets, deps.now)) return { ok: false, code: 'NO_SESSION_KEY' };
  // 全局会话随时可能被替换并就地清零：签名材料各拷一份，结束时清零这些拷贝。
  const kTotp = new Uint8Array(secrets.kTotp as Uint8Array);
  const keys = {
    sessKey: secrets.sessKey,
    sessSk: secrets.sessSk ? new Uint8Array(secrets.sessSk) : null,
  };
  const delegationBytes = new Uint8Array(secrets.delegationBytes);
  const delegationSig = new Uint8Array(secrets.delegationSig);
  const destroy = () => {
    kTotp.fill(0);
    keys.sessSk?.fill(0);
    delegationSig.fill(0);
  };
  let passkey: { credential_id: string; sig: string } | undefined;
  try {
    passkey =
      secrets.passkeyCredentialId && secrets.passkeySig
        ? { credential_id: secrets.passkeyCredentialId, sig: encodeBase64url(secrets.passkeySig) }
        : encodeSecondFactor(
            await maybeSecondFactor(input, deps, {
              uid: secrets.info.uid,
              delegationBytes,
              hasTotpCode: true,
            })
          );
  } catch (err) {
    destroy();
    return { ok: false, code: proofFailureCode(err, 'PASSKEY_INVALID') };
  }
  return {
    ok: true,
    material: {
      uid: secrets.info.uid,
      entry: secrets.info.entryNodeId,
      delegationBytes,
      delegationSig,
      totp: { code, k_totp: encodeBase64url(kTotp) },
      passkey,
      sign: (login) => signSessionLogin(keys, login),
      destroy,
    },
  };
}

async function passkeyProof(
  input: ProofInput,
  deps: LoginCodeProofDeps
): Promise<LoginCodeProofResult> {
  const uid = input.mode.uid;
  if (!uid) return { ok: false, code: 'PROTOCOL_MISMATCH' };
  const sess = await generateSessionKeyMaterial(deps.generateSessionKeyPair);
  try {
    const signed = await buildPasskeyDelegationForKey({
      api: deps.api,
      uid,
      sessPk: sess.publicKey,
      now: deps.now,
      origin: deps.origin,
    });
    return {
      ok: true,
      material: {
        uid,
        entry: input.selfMeshId,
        delegationBytes: signed.delegationBytes,
        delegationSig: signed.delegationSig,
        sign: (login) =>
          signSessionLogin({ sessKey: sess.cryptoKey, sessSk: sess.secretKey }, login),
        destroy: () => sess.destroy(),
      },
    };
  } catch (err) {
    sess.destroy();
    return { ok: false, code: proofFailureCode(err, 'PASSKEY_INVALID') };
  }
}

function defaultDeriveSeed(
  password: string,
  kdf: NonNullable<AuthModeResponse['kdfParams']>
): Promise<Uint8Array> {
  return deriveSeed(password, {
    salt: decodeBase64url(kdf.salt),
    memory_kib: kdf.memory_kib,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
  });
}

interface RootDelegation {
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
  kTotp: Uint8Array | null;
}

/** 与 `establishSessionFromSeed` 同一套：根钥操作整段同步，签完立刻清零 seed 与根钥副本。 */
function signRootDelegation(
  seed: Uint8Array,
  args: { uid: string; sessPk: Uint8Array; now: number; rootEpoch: number | null }
): RootDelegation {
  const rootKey = rootKeyFromSeed(seed);
  try {
    const signed = createDelegation(rootKey, { uid: args.uid, sessPk: args.sessPk, now: args.now });
    const kTotp = args.rootEpoch === null ? null : deriveTotpKey(seed, args.uid, args.rootEpoch);
    return { delegationBytes: signed.bytes, delegationSig: signed.sig, kTotp };
  } finally {
    seed.fill(0);
    rootKey.seed.fill(0);
  }
}

async function passwordProof(
  input: ProofInput,
  proof: { password: string; totpCode?: string },
  deps: LoginCodeProofDeps
): Promise<LoginCodeProofResult> {
  const { mode } = input;
  const uid = mode.uid;
  if (!uid || !mode.kdfParams) return { ok: false, code: 'PROTOCOL_MISMATCH' };
  const totpCode = mode.totpEnabled && proof.totpCode ? proof.totpCode : undefined;
  let rootEpoch: number | null = null;
  try {
    if (totpCode) rootEpoch = requireRootEpoch(mode);
  } catch {
    return { ok: false, code: 'PROTOCOL_MISMATCH' };
  }
  const sess = await generateSessionKeyMaterial(deps.generateSessionKeyPair);
  let root: RootDelegation | null = null;
  try {
    const seed = await (deps.deriveSeed ?? defaultDeriveSeed)(proof.password, mode.kdfParams);
    root = signRootDelegation(seed, { uid, sessPk: sess.publicKey, now: deps.now, rootEpoch });
    const passkey = await maybeSecondFactor(input, deps, {
      uid,
      delegationBytes: root.delegationBytes,
      hasTotpCode: Boolean(totpCode),
    });
    const owned = root;
    const kTotp = owned.kTotp;
    return {
      ok: true,
      material: {
        uid,
        entry: input.selfMeshId,
        delegationBytes: owned.delegationBytes,
        delegationSig: owned.delegationSig,
        totp: totpCode && kTotp ? { code: totpCode, k_totp: encodeBase64url(kTotp) } : undefined,
        passkey: encodeSecondFactor(passkey),
        sign: (login) =>
          signSessionLogin({ sessKey: sess.cryptoKey, sessSk: sess.secretKey }, login),
        destroy: () => {
          sess.destroy();
          kTotp?.fill(0);
          owned.delegationSig.fill(0);
        },
      },
    };
  } catch (err) {
    sess.destroy();
    root?.kTotp?.fill(0);
    return { ok: false, code: proofFailureCode(err, 'PROOF_FAILED') };
  }
}

export function buildLoginCodeProof(
  input: ProofInput,
  proof: LoginCodeProof,
  deps: LoginCodeProofDeps
): Promise<LoginCodeProofResult> {
  if (proof.kind === 'totp') return totpProof(input, proof.code, deps);
  if (proof.kind === 'passkey') return passkeyProof(input, deps);
  return passwordProof(input, proof, deps);
}
