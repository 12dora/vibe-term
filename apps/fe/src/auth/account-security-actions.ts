// 账号安全动作：改密 / TOTP / passkey。
// 每个动作都要 `POST /api/auth/keylog` 追加一条由根钥或 passkey 签名的记录，
// sk_sess 一概不参与——所以每个动作都会重新要一次密码或一次 passkey 交互。

import type { KeyLogAppendResult, PasskeySummary } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi, startRegistration } from '@vibeterm/api-client/auth/index';
import { type AddPasskeyPayload, decodeBase64url } from '@vibeterm/shared/auth';
import { appendKeyLog } from './account-security-keylog';
import type { SignerInput } from './account-security-totp';
import {
  buildAddPasskeyRecord,
  buildRemovePasskeyRecord,
  headFromResponse,
} from './key-log-actions';

export type { PasskeySummary };
export { rootSignerFromPassword, withRootSigner } from './account-security-keylog';
export type {
  ChangePasswordInput,
  ChangePasswordResult,
  MetaKeyRotationOutcome,
  SignedPasswordChange,
} from './account-security-password-change';
export { changePassword } from './account-security-password-change';
export type {
  BeginTotpSetupInput,
  ConfirmTotpSetupInput,
  ConfirmTotpSetupResult,
  SignerInput,
  TotpSetupDraft,
} from './account-security-totp';
export { beginTotpSetup, clearTotp, confirmTotpSetup } from './account-security-totp';

export interface RegisterPasskeyInput extends SignerInput {
  /** 用户给这把 passkey 起的名字，写进 add-passkey payload。 */
  name: string;
}

/**
 * 注册 passkey：仪式 → entry 用 @simplewebauthn/server 验证并抽出凭证字段 →
 * 前端签 `add-passkey` 记录（根钥或另一把 passkey）。
 */
export async function registerPasskey(input: RegisterPasskeyInput): Promise<KeyLogAppendResult> {
  const api = input.api ?? defaultAuthApi;
  const options = await api.passkeyRegisterOptions();
  const response = await startRegistration(options);
  const verified = await api.passkeyRegisterVerify(response, options.challenge_id);

  const payload: AddPasskeyPayload = {
    credential_id: verified.credential_id,
    public_key: decodeBase64url(verified.public_key),
    rp_id: verified.rp_id,
    origin: verified.origin,
    counter: verified.counter,
    transports: verified.transports ?? [],
    backup_eligible: verified.backup_eligible,
    backup_state: verified.backup_state,
    device_type: verified.device_type,
    name: input.name,
  };

  const head = await api.keyLogHead();
  const record = await buildAddPasskeyRecord({
    head: headFromResponse(head),
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    payload,
    signer: input.signer,
  });
  return appendKeyLog(api, record);
}

export interface RemovePasskeyInput extends SignerInput {
  credentialId: string;
}

export async function removePasskey(input: RemovePasskeyInput): Promise<KeyLogAppendResult> {
  const api = input.api ?? defaultAuthApi;
  const head = await api.keyLogHead();
  const record = await buildRemovePasskeyRecord({
    head: headFromResponse(head),
    rootEpoch: head.rootEpoch,
    uid: input.uid,
    credentialId: input.credentialId,
    signer: input.signer,
  });
  return appendKeyLog(api, record);
}

/**
 * 只保留注册 origin 与当前 origin **完全一致**的 passkey。
 *
 * passkey 绑定注册时的精确 origin（scheme + host + port）：拿 node A 的凭证在 node B 发起
 * 断言，浏览器直接 `NotAllowedError`。签记录时必须从这个子集里选，不能盲取列表第一把
 * （见 F4-1 评审 Major）。
 *
 * **没有 `rp_id` 回退**：凭证注册于 `https://node.example:8443`、当前页面是
 * `https://node.example` 时，两者 rp_id 相同但 origin 不同，后端按注册 origin 验断言必然拒绝；
 * 把它标成「可用」只会给用户一个注定失败的按钮（见 F4-fix 评审 Major）。
 */
export function passkeysForOrigin(passkeys: PasskeySummary[], origin?: string): PasskeySummary[] {
  return passkeys.filter((row) => isPasskeyUsableHere(row, origin));
}

/**
 * 这把凭证能不能在**当前入口**发起断言。
 *
 * 服务端下发的 `usableHere`（B2-8：`row.origin === 本次请求的可信 origin`）优先——反代之后
 * 浏览器看到的 origin 未必是断言真正用的那个，服务端的判定才作数。旧 entry 不带该字段时，
 * 退回 origin 字符串全等（同样没有 `rp_id` 回退）。
 */
export function isPasskeyUsableHere(row: PasskeySummary, origin?: string): boolean {
  if (typeof row.usableHere === 'boolean') return row.usableHere;
  const current =
    origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
  if (!current) return true;
  return row.origin === current;
}
