// 账号安全面板里改密这一条流程的纯逻辑：错误文案映射、改密后的会话收尾。
//
// 从面板组件里拆出来只是为了让那个文件不再继续膨胀；这里不含任何 JSX，
// 也因此能被单测直接调用（见 `account-security-panel.test.tsx`）。

import {
  type MetaKeyRotationOutcome,
  type SignedPasswordChange,
  changePassword,
} from '@/auth/account-security-actions';
import { clearSessionKey, getSessionKey } from '@/auth/session-key-store';
import { resumeSessionAfterPasswordChange } from '@/auth/session-login';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { HUB_NOT_WRITER } from '@tmex/api-client/auth/index';
import { KEYLOG_TYPE_UNSUPPORTED_BY_NODES } from '@tmex/shared/auth';

const HUB_TIMEOUT = 'HUB_TIMEOUT';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * key-log 动作失败的文案。多 hub 下三个码必须给出下一步该去哪台机器操作，
 * 通用错误表里那句「请通过主 Hub 操作」在账号安全这条路径上说不清楚要先做什么。
 */
export function securityActionErrorText(t: Translate, code: string): string {
  if (code === HUB_TIMEOUT) return t('auth.security.primaryHubUnreachable');
  if (code === HUB_NOT_WRITER) return t('auth.security.switchToPrimaryHub');
  if (code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) return t('auth.security.nodesTooOld');
  return t(`auth.errors.${code}`, { defaultValue: code });
}

// ---------------------------------------------------------------------------
// 改密
// ---------------------------------------------------------------------------

export type PasswordChangeFollowUp = 'clear-session' | 'resume-session' | 'keep-session';

/**
 * 改密成功后拿浏览器这份会话怎么办。
 *
 * - `clear-session`：全量重置撤销了全部会话，本地连 IndexedDB 一起清掉；
 * - `resume-session`：常规改密不撤销会话，用新密码重建 delegation 再登录一次 entry；
 * - `keep-session`：开了 TOTP 却没给验证码，重新登录做不了，保留手上这份仍然有效的会话。
 */
export function passwordChangeFollowUp(input: {
  fullReset: boolean;
  totpEnabled: boolean;
  totpCode: string;
}): PasswordChangeFollowUp {
  if (input.fullReset) return 'clear-session';
  if (input.totpEnabled && !/^\d{6}$/.test(input.totpCode)) return 'keep-session';
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
}

/**
 * 用新密码重建 delegation 并重新登录一次 entry。
 *
 * kdf 参数与 root_epoch 以**本次签进记录的值**为准，`/api/auth/mode` 只是拿来确认；确认不上
 * 也照样按签进去的那份重建。任何失败都只是「没接上」——密码已经改成功了，不能反过来报成
 * 改密失败；旧会话由 `replaceSessionKey()` 保住，调用方只给一行提示。
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
}

/** 改密成功后的收尾：只有全量重置才清会话钥；常规改密走两阶段替换，失败也不动旧会话。 */
export async function finishPasswordChange(
  input: ResumeSessionInput & { follow: PasswordChangeFollowUp; t: Translate }
): Promise<PasswordChangeFeedback> {
  if (input.follow === 'clear-session') {
    // rotate-root 撤销所有会话：等盘上那份也删掉再往下走，否则用户随手刷新一下，
    // IndexedDB 里那份已被服务端撤销的会话钥又会被恢复出来。
    await clearSessionKey();
    return { tone: 'ok', text: input.t('auth.security.changePasswordDone') };
  }
  if (input.follow === 'keep-session') {
    return { tone: 'notice', text: input.t('auth.security.sessionResumeSkipped') };
  }
  const resumed = await resumeSession(input);
  return resumed
    ? { tone: 'ok', text: input.t('auth.security.changePasswordKeepDone') }
    : { tone: 'notice', text: input.t('auth.security.sessionResumeFailed') };
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
    // 改密与紧随其后的 `meta-key` 必须连成一段，且与 admit / revoke 抢同一个 key log 头。
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
    totpEnabled: input.totpEnabled,
    // 服务端还没应用完记录时 `/api/auth/mode` 给的是旧 epoch；重建会话只认这两个签进去的值。
    signed: { nextRootEpoch: result.nextRootEpoch, newKdfParams: result.newKdfParams },
    follow: passwordChangeFollowUp(input),
    t: input.t,
  });
  return withMetaKeyNotice(feedback, result.metaKey, input.t);
}

/**
 * 中继模式下改密要顺带换一代元数据密钥（plan §1.3）。没换成不能当没事发生：
 * 全量重置（`rotate-root`）会当场撤销全部会话，那条记录必然要等重新登录后才送得出去——
 * 它已经签好并落在待办里，节点页会一直挂告警直到送达。
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
