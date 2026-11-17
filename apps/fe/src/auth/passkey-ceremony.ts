// 通行密钥仪式：passkey delegation 的构造与密码登录的二次验证（登录与签发登录命令共用）。
// 只产出签名材料，不碰全局会话。

import type {
  AuthApi,
  AuthenticationResponseJSON,
  PasskeySummary,
  PublicKeyCredentialRequestOptionsJSON,
} from '@vibeterm/api-client/auth/index';
import { startAuthentication } from '@vibeterm/api-client/auth/index';
import type { Delegation } from '@vibeterm/shared/auth';
import {
  buildPasskeyDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeDelegation,
  encodePasskeyAssertion,
} from '@vibeterm/shared/auth';
import { selectPasskeyCredential } from './passkey-credential-select';

/**
 * WebAuthn 断言仪式。真实实现来自 `@vibeterm/api-client`，测试用 `setPasskeyCeremonyForTest()`
 * 换掉——bun 里没有认证器，没有这个接缝就只能测失败路径。
 */
let passkeyCeremony: (
  options: PublicKeyCredentialRequestOptionsJSON
) => Promise<AuthenticationResponseJSON> = startAuthentication;

/** 仅测试使用：替换 WebAuthn 断言仪式，不传则还原成真实实现。 */
export function setPasskeyCeremonyForTest(
  fn?: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<AuthenticationResponseJSON>
): void {
  passkeyCeremony = fn ?? startAuthentication;
}

export class PasskeyCredentialUnknownError extends Error {
  readonly code = 'PASSKEY_CREDENTIAL_UNKNOWN';
  constructor() {
    super('no passkey credential available for this entry');
    this.name = 'PasskeyCredentialUnknownError';
  }
}

export function currentOrigin(override?: string): string {
  if (override) return override;
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
}

function assertionBytes(assertion: AuthenticationResponseJSON): Uint8Array {
  return encodePasskeyAssertion({
    credential_id: assertion.id,
    client_data_json: decodeBase64url(assertion.response.clientDataJSON),
    authenticator_data: decodeBase64url(assertion.response.authenticatorData),
    signature: decodeBase64url(assertion.response.signature),
  });
}

export interface PasskeyDelegation {
  delegation: Delegation;
  delegationBytes: Uint8Array;
  /** borsh(PasskeyAssertion)，即登录体的 `delegation_sig`。 */
  delegationSig: Uint8Array;
  credentialId: string;
}

/**
 * 为给定 `sess_pk` 签一份 passkey delegation。
 *
 * delegation 里必须先写死 credential_id（challenge = sha256(borsh(delegation))），
 * 而凭证列表只有 entry 知道——所以先用一个探测 delegation 换回 `allowCredentials`，
 * 选定凭证后再用最终 delegation 换一次 options。
 *
 * 凭证由 `selectPasskeyCredential()` 决定，前端**不做**「取第一把」这种猜测。候选不唯一且没有
 * 可信 origin 元数据时（登录前多半如此），先把服务端那份 `allowCredentials` **原样**交给
 * WebAuthn 做一次探测仪式，由浏览器 / 认证器选出用户手上真正有的那把，再用它绑定最终
 * delegation 做正式仪式——协议要求 challenge 覆盖 credential_id，这一步换不掉。
 * 单候选（后端按精确 origin 过滤后的常态）只做一次仪式。
 */
export async function buildPasskeyDelegationForKey(opts: {
  api: AuthApi;
  uid: string;
  sessPk: Uint8Array;
  now: number;
  credentialId?: string;
  origin?: string;
  passkeys?: PasskeySummary[] | null;
}): Promise<PasskeyDelegation> {
  const { api } = opts;
  const buildFor = (credentialId: string) =>
    buildPasskeyDelegation({ uid: opts.uid, sessPk: opts.sessPk, now: opts.now, credentialId });

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
      const probe = await passkeyCeremony({
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
  const assertion = await passkeyCeremony({ ...options, allowCredentials: [{ id: credentialId }] });
  if (assertion.id !== credentialId) {
    throw new Error('passkey assertion credential mismatch');
  }
  return {
    delegation,
    delegationBytes: encodeDelegation(delegation),
    delegationSig: assertionBytes(assertion),
    credentialId,
  };
}

/** 一次通行密钥二次验证的产物：断言字节与它绑定的凭证 id。 */
export interface PasskeySecondFactor {
  credentialId: string;
  /** borsh(PasskeyAssertion)，与登录体的 `passkey.sig` 同一份编码。 */
  sig: Uint8Array;
}

/**
 * 密码登录的通行密钥二次验证。
 *
 * challenge 就是 `delegationChallenge(delegation)` = sha256(borsh(delegation))，与 passkey 直接
 * 登录完全相同——所以一次仪式产出的断言，在 delegation 的 18 小时里对**所有** node 都有效，
 * 用户不会每登录一台就被弹一次指纹。
 *
 * 这里**不拉** `/api/auth/passkeys`：这一步发生在拿到会话之前，那个接口必然 401。凭证范围由
 * 服务端按精确 origin 过滤过的 `allowCredentials` 决定，候选不唯一时原样交给浏览器选，
 * 绝不盲取第一把（见 `selectPasskeyCredential`）。root delegation 不绑 credential_id，
 * 因此不需要 passkey 直接登录那套「探测 + 绑定」两次仪式。
 *
 * 本地址一把凭证都没有（`NO_PASSKEY_FOR_ORIGIN`）时返回 null：服务端的二次验证同样按 origin
 * 判定，此时它不会要求断言。这条只是 mode 快照过期时的兜底，避免把用户卡在一个做不完的仪式上。
 */
export async function runPasskeySecondFactor(args: {
  api: AuthApi;
  uid: string;
  delegationBytes: Uint8Array;
  origin?: string;
  onPrompt?: () => void;
}): Promise<PasskeySecondFactor | null> {
  const options = await args.api
    .passkeyLoginOptions(args.uid, encodeBase64url(args.delegationBytes))
    .catch((err: unknown) => {
      if ((err as { code?: string } | null)?.code === 'NO_PASSKEY_FOR_ORIGIN') return null;
      throw err;
    });
  if (!options) return null;
  const selection = selectPasskeyCredential({
    allowCredentials: options.allowCredentials,
    passkeys: null,
    origin: currentOrigin(args.origin),
  });
  if (selection.kind === 'none') throw new PasskeyCredentialUnknownError();
  const allowCredentials =
    selection.kind === 'bind' ? [{ id: selection.credentialId }] : selection.allowCredentials;

  args.onPrompt?.();
  const assertion = await passkeyCeremony({ ...options, allowCredentials });
  return { credentialId: assertion.id, sig: assertionBytes(assertion) };
}
