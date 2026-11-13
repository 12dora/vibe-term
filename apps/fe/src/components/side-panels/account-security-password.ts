// 账号安全面板里改密这一条流程的纯逻辑：错误文案映射、改密后的会话收尾。
//
// 从面板组件里拆出来只是为了让那个文件不再继续膨胀；这里不含任何 JSX，
// 也因此能被单测直接调用（见 `account-security-panel.test.tsx`）。

import {
  type MetaKeyRotationOutcome,
  type SignedPasswordChange,
  changePassword,
  settleRelayAfterPasswordChange,
} from '@/auth/account-security-actions';
import { clearLocalDeviceCaches } from '@/auth/logout-local-caches';
import { clearSessionKey, getSessionKey } from '@/auth/session-key-store';
import { resumeSessionAfterPasswordChange } from '@/auth/session-login';
import { withKeyLogLock } from '@/node/enrollment-engine';
import { type RelayAckFields, relayAckError, relayAckErrorText } from '@/node/relay-ack';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@vibeterm/api-client/auth/index';
import { handleGlobalUnauthorized } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { KEYLOG_TYPE_UNSUPPORTED_BY_NODES, checkAccountPassword } from '@vibeterm/shared/auth';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * key-log 动作失败的文案。节点版本过低单独给一句，其余落回通用错误表。
 */
export function securityActionErrorText(t: Translate, code: string): string {
  if (code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) return t('auth.security.nodesTooOld');
  return t(`auth.errors.${code}`, { defaultValue: code });
}

// ---------------------------------------------------------------------------
// 改密
// ---------------------------------------------------------------------------

export type PasswordChangeFollowUp = 'resume-session' | 'sign-in';

/**
 * 改密成功后拿浏览器这份会话怎么办。任何改密（常规与全量重置）都会让服务端撤销**全部**节点上的
 * 会话、包括当前这份，本地手上的旧会话已经是废的：
 *
 * - `resume-session`：用内存里的新密码重建 delegation 再登录一次 entry，其余节点由既有的静默重登补上；
 * - `sign-in`：开了 TOTP 却没给验证码（全量重置会清掉 TOTP，不受影响），静默登录做不了，直接回登录页。
 */
export function passwordChangeFollowUp(input: {
  fullReset: boolean;
  totpEnabled: boolean;
  totpCode: string;
}): PasswordChangeFollowUp {
  if (!input.fullReset && input.totpEnabled && !/^\d{6}$/.test(input.totpCode)) return 'sign-in';
  return 'resume-session';
}

/** `/api/auth/mode` 最多再确认几次，以及两次之间等多久。 */
const MODE_POLL_TRIES = 3;
const MODE_POLL_INTERVAL_MS = 200;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 等 `/api/auth/mode` 报出记录应用之后的 root_epoch。
 *
 * 记录是异步应用的：改密刚返回时这里很可能还给着旧 epoch 与旧 kdf 参数，拿它重建
 * delegation 必然验不过。最多问 `MODE_POLL_TRIES` 次，还没追上就返回 null——调用方回落到
 * 本次**签进记录**的那两个值，它们才是权威。
 */
async function pollModeForEpoch(input: {
  api: AuthApi;
  expected: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AuthModeResponse | null> {
  const sleep = input.sleep ?? wait;
  for (let tries = 0; tries < MODE_POLL_TRIES; tries += 1) {
    if (tries > 0) await sleep(MODE_POLL_INTERVAL_MS);
    const next = await input.api.getMode().catch(() => null);
    if (next && next.rootEpoch === input.expected) return next;
  }
  return null;
}

interface ResumeSessionInput {
  api: AuthApi;
  uid: string;
  password: string;
  totpCode: string;
  totpEnabled: boolean;
  nodeId: string;
  signed: SignedPasswordChange;
  sleep?: (ms: number) => Promise<void>;
  /** 中继模式：重新登录成功后还掉改密留下的 `meta-key` 与密封包欠账。 */
  relay?: { relayApi?: RelayTenantApi };
}

/**
 * 用新密码重建 delegation 并重新登录一次 entry。
 *
 * kdf 参数与 root_epoch 以**本次签进记录的值**为准，`/api/auth/mode` 只是拿来确认；确认不上
 * 也照样按签进去的那份重建。任何失败都只是「没接上」——密码已经改成功了，不能反过来报成
 * 改密失败；调用方据返回值决定回登录页。
 */
async function resumeSession(input: ResumeSessionInput): Promise<boolean> {
  try {
    const confirmed = await pollModeForEpoch({
      api: input.api,
      expected: input.signed.nextRootEpoch,
      sleep: input.sleep,
    });
    const result = await resumeSessionAfterPasswordChange({
      api: input.api,
      uid: input.uid,
      password: input.password,
      kdfParams: confirmed?.kdfParams ?? input.signed.newKdfParams,
      entryNodeId: getSessionKey()?.entryNodeId ?? confirmed?.nodeId ?? input.nodeId,
      rootEpoch: input.signed.nextRootEpoch,
      hasTotp: confirmed ? Boolean(confirmed.totpEnabled) : input.totpEnabled,
      totpCode: input.totpCode || undefined,
    });
    return result.ok;
  } catch {
    return false;
  }
}

export interface PasswordChangeFeedback {
  tone: 'ok' | 'notice';
  text: string;
  /** 重新登录后当场补发 `meta-key` 的最终结论；没有补发时缺省。 */
  metaKey?: MetaKeyRotationOutcome;
}

/** 回登录页：带上当前地址作 `next`，由会话拦截器注入的路由跳转执行。 */
function redirectToLogin(): void {
  handleGlobalUnauthorized('/api/auth/keylog');
}

/**
 * 改密成功后的收尾：静默接回会话；接不回（没给验证码、重登失败或抛异常）就把已被服务端撤销的
 * 本地会话连 IndexedDB 一起清掉，干净地回登录页——密码已经改成功，不能报成改密失败。
 */
export async function finishPasswordChange(
  input: ResumeSessionInput & {
    follow: PasswordChangeFollowUp;
    t: Translate;
    toLogin?: () => void;
  }
): Promise<PasswordChangeFeedback> {
  if (input.follow === 'resume-session' && (await resumeSession(input))) {
    // 新会话已经建好、新密码还在内存里：欠账趁现在还，别留给「用户记得回节点页」。
    const metaKey = input.relay
      ? await settleRelayAfterPasswordChange({
          api: input.api,
          relayApi: input.relay.relayApi,
          lock: withKeyLogLock,
          uid: input.uid,
          password: input.password,
          signed: input.signed,
        })
      : undefined;
    return {
      tone: 'ok',
      text: input.t('auth.security.changePasswordDone'),
      ...(metaKey ? { metaKey } : {}),
    };
  }
  // 清盘要等删完再跳：否则新 document 会把这份已撤销的会话钥恢复出来，登录页又被弹回。
  await clearSessionKey();
  clearLocalDeviceCaches();
  (input.toLogin ?? redirectToLogin)();
  return { tone: 'notice', text: input.t('auth.security.changePasswordSignIn') };
}

export function passwordInputError(
  t: Translate,
  input: { oldPassword: string; newPassword: string; confirm: string },
  username: string | null
): string | null {
  if (!input.oldPassword || !input.newPassword) return t('auth.security.passwordRequired');
  if (input.newPassword !== input.confirm) return t('auth.security.passwordMismatch');
  const issue = checkAccountPassword(input.newPassword, { username: username ?? undefined });
  if (issue === 'too_short') return t('auth.security.passwordTooShort');
  if (issue === 'too_simple') return t('auth.security.passwordTooSimple');
  return null;
}

export interface PasswordChangeRequest {
  api: AuthApi;
  uid: string;
  nodeId: string;
  kdfParams: AuthKdfParamsJson;
  oldPassword: string;
  newPassword: string;
  fullReset: boolean;
  totpEnabled: boolean;
  totpCode: string;
  t: Translate;
  relayApi?: RelayTenantApi;
}

type PasswordChangeOutcome = { tone: 'error'; text: string } | PasswordChangeFeedback;

export async function submitPasswordChange(
  input: PasswordChangeRequest
): Promise<PasswordChangeOutcome> {
  const result = await changePassword({
    api: input.api,
    uid: input.uid,
    oldPassword: input.oldPassword,
    newPassword: input.newPassword,
    currentKdfParams: input.kdfParams,
    fullReset: input.fullReset,
    totpEnabled: input.totpEnabled,
    relayApi: input.relayApi,
    // 改密与随后待发的 `meta-key` 必须连成一段，且与 admit / revoke 抢同一个 key log 头。
    lock: withKeyLogLock,
  });
  if (!result.ok) {
    return { tone: 'error', text: securityActionErrorText(input.t, result.code) };
  }
  const feedback = await finishPasswordChange({
    api: input.api,
    uid: input.uid,
    nodeId: input.nodeId,
    password: input.newPassword,
    totpCode: input.totpCode,
    // 全量重置会清掉 TOTP：重新登录不再需要验证码。
    totpEnabled: input.totpEnabled && !input.fullReset,
    // 服务端还没应用完记录时 `/api/auth/mode` 给的是旧 epoch；重建会话只认这两个签进去的值。
    signed: { nextRootEpoch: result.nextRootEpoch, newKdfParams: result.newKdfParams },
    follow: passwordChangeFollowUp(input),
    t: input.t,
    relay: result.metaKey ? { relayApi: input.relayApi } : undefined,
  });
  // 两条补充说明各自独立：元数据密钥没换代、以及这条改密记录没上中继。
  return withRelayAckNotice(
    withMetaKeyNotice(feedback, feedback.metaKey ?? result.metaKey, input.t),
    result,
    input.t
  );
}

/**
 * 中继模式下改密记录只落了本机：成员节点仍认旧根公钥，接不上，也解不开后续记录。
 * 与元数据密钥那条一样必须说出来——只报「已修改密码」会让人以为整套都跟上了。
 */
export function withRelayAckNotice(
  feedback: PasswordChangeFeedback,
  result: RelayAckFields,
  t: Translate
): PasswordChangeFeedback {
  const code = relayAckError(result);
  if (code === null) return feedback;
  const warning = t('relay.tenant.relayAck.warning', { error: relayAckErrorText(t, code) });
  return { tone: 'notice', text: `${feedback.text} ${warning}` };
}

/**
 * 中继模式下改密要顺带换一代元数据密钥（plan §1.3）。没换成不能当没事发生：
 * 记录落账时会话就被撤销，那条记录只能在重新登录之后送出——先由 `finishPasswordChange` 当场补发，
 * 补不上（没接回会话、中继离线）就留在待办里，节点页会一直挂告警直到送达。
 */
export function withMetaKeyNotice(
  feedback: PasswordChangeFeedback,
  metaKey: MetaKeyRotationOutcome | undefined,
  t: Translate
): PasswordChangeFeedback {
  if (!metaKey || metaKey.ok) return feedback;
  return {
    tone: 'notice',
    text: `${feedback.text} ${t('relay.tenant.metaKey.afterPasswordChange')}`,
  };
}
