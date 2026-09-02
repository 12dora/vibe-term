// 账号安全面板（右侧滑出，`?panel=security`）：改密、TOTP、passkey。
//
// 原先是 `/account/security` 整页。做成面板后不再打断当前页面，也不必再为它单独留一条
// 无侧栏路由；`standalone`（`mode==='none'`）下整块返回 null，入口本身也不会出现。

import {
  type TotpSetupDraft,
  beginTotpSetup,
  changePassword,
  clearTotp,
  confirmTotpSetup,
  isPasskeyUsableHere,
  registerPasskey,
  removePasskey,
} from '@/auth/account-security-actions';
import {
  type CredentialPromptHandle,
  decodeRootPublicKey,
  useCredentialPrompt,
} from '@/auth/credential-prompt';
import { clearSessionKey, getSessionKey } from '@/auth/session-key-store';
import { resumeSessionAfterPasswordChange } from '@/auth/session-login';
import { useAuthMode } from '@/auth/use-session-key';
import type {
  AuthApi,
  AuthKdfParamsJson,
  AuthModeResponse,
  PasskeySummary,
} from '@tmex/api-client/auth/index';
import { HUB_NOT_WRITER, defaultAuthApi } from '@tmex/api-client/auth/index';
import { KEYLOG_TYPE_UNSUPPORTED_BY_NODES } from '@tmex/shared/auth';
import { Button } from '@tmex/ui/button';
import { Checkbox } from '@tmex/ui/checkbox';
import { Input } from '@tmex/ui/input';
import { OtpInput } from '@tmex/ui/otp-input';
import { AlertTriangle, Fingerprint, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface AccountSecurityPanelProps {
  mode?: AuthModeResponse;
  api?: AuthApi;
}

export default function AccountSecurityPanel({
  mode: modeOverride,
  api = defaultAuthApi,
}: AccountSecurityPanelProps) {
  const fetched = useAuthMode(api, { enabled: !modeOverride });
  const mode = modeOverride ?? fetched.mode;

  if (!modeOverride && fetched.loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-8 text-muted-foreground"
        data-testid="security-panel-pending"
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }
  if (!mode || mode.mode === 'none') {
    return null;
  }
  return <AccountSecurity mode={mode} api={api} reloadMode={fetched.reload} />;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

const FEEDBACK_TONE = {
  error: 'text-destructive',
  ok: 'text-emerald-500',
  notice: 'text-muted-foreground',
} as const;

function Feedback({ tone, text }: { tone: keyof typeof FEEDBACK_TONE; text: string }) {
  return (
    <p className={`text-xs ${FEEDBACK_TONE[tone]}`} data-testid={`security-${tone}`}>
      {text}
    </p>
  );
}

const HUB_TIMEOUT = 'HUB_TIMEOUT';

type Translate = (key: string, options?: Record<string, unknown>) => string;

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

interface AccountSecurityProps {
  mode: AuthModeResponse;
  api: AuthApi;
  reloadMode: () => void;
}

/** 已确认存在用户与 kdf 参数的 mode（各 Section 都依赖这两项）。 */
type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };

function AccountSecurity({ mode: rawMode, api, reloadMode }: AccountSecurityProps) {
  const { t } = useTranslation();
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeysError, setPasskeysError] = useState<string | null>(null);

  const reloadPasskeys = useCallback(() => {
    api
      .listPasskeys()
      .then((rows) => {
        setPasskeys(rows);
        setPasskeysError(null);
      })
      .catch((err: unknown) => {
        setPasskeys([]);
        setPasskeysError(err instanceof Error ? err.message : String(err));
      });
  }, [api]);

  useEffect(() => reloadPasskeys(), [reloadPasskeys]);

  // 除 rotate-root（必须要旧根钥）与 set-totp（要 seed 派生 k_totp）外，
  // 其余动作都可以用密码或本 origin 的 passkey 授权。
  const prompt = useCredentialPrompt({
    kdfParams: rawMode.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode.rootPublicKey),
    passkeys,
    passkeyAvailable: rawMode.passkeyAvailable,
  });

  if (!rawMode.uid || !rawMode.kdfParams) {
    return <div className="text-sm text-muted-foreground">{t('auth.errors.UNKNOWN_USER')}</div>;
  }
  const mode: ResolvedMode = { ...rawMode, uid: rawMode.uid, kdfParams: rawMode.kdfParams };
  const uid = mode.uid;

  return (
    <div className="flex w-full flex-col gap-4" data-testid="account-security-panel">
      <PasswordSection mode={mode} api={api} uid={uid} onDone={reloadMode} />
      <TotpSection
        mode={mode}
        api={api}
        uid={uid}
        passkeys={passkeys}
        prompt={prompt}
        onDone={reloadMode}
      />
      <PasskeySection
        mode={mode}
        api={api}
        uid={uid}
        prompt={prompt}
        passkeys={passkeys}
        listError={passkeysError}
        onDone={() => {
          reloadPasskeys();
          reloadMode();
        }}
      />
      <p className="px-1 text-xs text-muted-foreground">{t('auth.security.sessionKeyNote')}</p>
      {prompt.dialog}
    </div>
  );
}

/** hook 不能条件调用；缺 kdf 参数时整页只渲染「用户不存在」，这份占位不会被用到。 */
const PLACEHOLDER_KDF: AuthKdfParamsJson = {
  salt: '',
  memory_kib: 0,
  iterations: 0,
  parallelism: 0,
};

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

/**
 * 重新读一次 `/api/auth/mode`：新 kdf 参数与 root_epoch 只有服务端应用完记录才作准。
 *
 * 任何失败都只是「没接上」——密码已经改成功了，不能反过来报成改密失败；旧会话由
 * `replaceSessionKey()` 保住，调用方只给一行提示。
 */
async function resumeSession(input: {
  api: AuthApi;
  uid: string;
  password: string;
  totpCode: string;
}): Promise<boolean> {
  try {
    const next = await input.api.getMode();
    if (!next.kdfParams || typeof next.rootEpoch !== 'number') return false;
    const result = await resumeSessionAfterPasswordChange({
      api: input.api,
      uid: input.uid,
      password: input.password,
      kdfParams: next.kdfParams,
      entryNodeId: getSessionKey()?.entryNodeId ?? next.nodeId,
      rootEpoch: next.rootEpoch,
      hasTotp: Boolean(next.totpEnabled),
      totpCode: input.totpCode || undefined,
    });
    return result.ok;
  } catch {
    return false;
  }
}

interface PasswordChangeFeedback {
  tone: 'ok' | 'notice';
  text: string;
}

/** 改密成功后的收尾：只有全量重置才清会话钥；常规改密走两阶段替换，失败也不动旧会话。 */
export async function finishPasswordChange(input: {
  api: AuthApi;
  uid: string;
  password: string;
  totpCode: string;
  follow: PasswordChangeFollowUp;
  t: Translate;
}): Promise<PasswordChangeFeedback> {
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

interface PasswordChangeRequest {
  api: AuthApi;
  uid: string;
  kdfParams: AuthKdfParamsJson;
  oldPassword: string;
  newPassword: string;
  fullReset: boolean;
  totpEnabled: boolean;
  totpCode: string;
  t: Translate;
}

type PasswordChangeOutcome = { tone: 'error'; text: string } | PasswordChangeFeedback;

async function submitPasswordChange(input: PasswordChangeRequest): Promise<PasswordChangeOutcome> {
  const result = await changePassword({
    api: input.api,
    uid: input.uid,
    oldPassword: input.oldPassword,
    newPassword: input.newPassword,
    currentKdfParams: input.kdfParams,
    fullReset: input.fullReset,
    totpEnabled: input.totpEnabled,
  });
  if (!result.ok) {
    return { tone: 'error', text: securityActionErrorText(input.t, result.code) };
  }
  return finishPasswordChange({
    api: input.api,
    uid: input.uid,
    password: input.newPassword,
    totpCode: input.totpCode,
    follow: passwordChangeFollowUp(input),
    t: input.t,
  });
}

function PasswordFields({
  oldPassword,
  newPassword,
  confirm,
  onOldPassword,
  onNewPassword,
  onConfirm,
}: {
  oldPassword: string;
  newPassword: string;
  confirm: string;
  onOldPassword: (value: string) => void;
  onNewPassword: (value: string) => void;
  onConfirm: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        type="password"
        autoComplete="current-password"
        placeholder={t('auth.security.currentPassword')}
        value={oldPassword}
        data-testid="security-old-password"
        onChange={(event) => onOldPassword(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={t('auth.security.newPassword')}
        value={newPassword}
        data-testid="security-new-password"
        onChange={(event) => onNewPassword(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={t('auth.security.confirmPassword')}
        value={confirm}
        data-testid="security-confirm-password"
        onChange={(event) => onConfirm(event.target.value)}
      />
    </>
  );
}

/** 常规改密后要重新登录一次 entry；开了 TOTP 就得当场给一个码，留空则跳过。 */
function ReloginCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">{t('auth.security.reloginTotpHint')}</p>
      <OtpInput
        value={value}
        onChange={onChange}
        digitLabel={(index, length) => t('auth.totpDigit', { index: index + 1, total: length })}
        data-testid="security-relogin-code"
      />
    </div>
  );
}

/** 全量重置的开关与它的破坏性警告：勾上之前不摆警告，免得常规改密被误读成会清空一切。 */
function FullResetOption({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <label className="flex items-start gap-2 text-xs" htmlFor="security-full-reset">
        <Checkbox
          id="security-full-reset"
          checked={checked}
          onCheckedChange={(next) => onChange(next === true)}
          data-testid="security-full-reset"
        />
        <span className="flex flex-col gap-0.5">
          {t('auth.security.fullReset')}
          <span className="text-muted-foreground">{t('auth.security.fullResetHint')}</span>
        </span>
      </label>
      {checked ? (
        <p
          className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="password-warning"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('auth.security.changePasswordWarning')}</span>
        </p>
      ) : null}
    </>
  );
}

/** 单独导出供测试静态渲染：`initialFullReset` 只用来摆出勾选后的形态。 */
export function PasswordSection({
  mode,
  api,
  uid,
  onDone,
  initialFullReset = false,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  onDone: () => void;
  initialFullReset?: boolean;
}) {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fullReset, setFullReset] = useState(initialFullReset);
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<PasswordChangeFeedback | null>(null);
  const totpEnabled = Boolean(mode.totpEnabled);

  const submit = useCallback(async () => {
    setError(null);
    setFeedback(null);
    if (!oldPassword || !newPassword) {
      setError(t('auth.security.passwordRequired'));
      return;
    }
    if (newPassword !== confirm) {
      setError(t('auth.security.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      const outcome = await submitPasswordChange({
        api,
        uid,
        kdfParams: mode.kdfParams,
        oldPassword,
        newPassword,
        fullReset,
        totpEnabled,
        totpCode,
        t,
      });
      if (outcome.tone === 'error') {
        setError(outcome.text);
        return;
      }
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setTotpCode('');
      setFeedback(outcome);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    api,
    confirm,
    fullReset,
    mode.kdfParams,
    newPassword,
    oldPassword,
    onDone,
    t,
    totpCode,
    totpEnabled,
    uid,
  ]);

  return (
    <Section title={t('auth.security.changePassword')}>
      <PasswordFields
        oldPassword={oldPassword}
        newPassword={newPassword}
        confirm={confirm}
        onOldPassword={setOldPassword}
        onNewPassword={setNewPassword}
        onConfirm={setConfirm}
      />
      {totpEnabled && !fullReset ? (
        <ReloginCodeField value={totpCode} onChange={setTotpCode} />
      ) : null}
      <FullResetOption checked={fullReset} onChange={setFullReset} />
      {error ? <Feedback tone="error" text={error} /> : null}
      {feedback ? <Feedback tone={feedback.tone} text={feedback.text} /> : null}
      <div>
        <Button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          data-testid="security-change-password"
        >
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {t('auth.security.changePassword')}
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

function TotpSection({
  mode,
  api,
  uid,
  passkeys,
  prompt,
  onDone,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  passkeys: PasskeySummary[];
  prompt: CredentialPromptHandle;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  // 第一阶段的草稿：密钥只在内存，用户确认验证码之前不会写任何 key-log 记录。
  const [draft, setDraft] = useState<TotpSetupDraft | null>(null);
  const [code, setCode] = useState('');

  // 组件卸载时清掉未确认的密钥字节。
  useEffect(
    () => () => {
      draft?.secret.fill(0);
    },
    [draft]
  );

  const begin = useCallback(() => {
    setError(null);
    setOk(false);
    setCode('');
    setDraft(beginTotpSetup({ uid, issuer: 'tmex' }));
  }, [uid]);

  const confirm = useCallback(async () => {
    setError(null);
    if (!draft) return;
    if (!password) {
      setError(t('auth.security.passwordRequired'));
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError(t('auth.security.totpCodeRequired'));
      return;
    }
    setBusy(true);
    try {
      const outcome = await confirmTotpSetup({
        api,
        uid,
        password,
        currentKdfParams: mode.kdfParams,
        secret: draft.secret,
        code,
      });
      setPassword('');
      if (!outcome.ok) {
        setError(t('auth.errors.TOTP_INVALID'));
        return;
      }
      if (!outcome.result.ok) {
        setError(securityActionErrorText(t, outcome.result.code));
        return;
      }
      draft.secret.fill(0);
      setDraft(null);
      setCode('');
      setOk(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, code, draft, mode.kdfParams, onDone, password, t, uid]);

  const cancel = useCallback(() => {
    draft?.secret.fill(0);
    setDraft(null);
    setCode('');
    setError(null);
  }, [draft]);

  /** `clear-totp` 允许 passkey 签（不需要 seed），走统一的凭据对话框。 */
  const disable = useCallback(async () => {
    setError(null);
    setOk(false);
    setBusy(true);
    try {
      const result = await prompt.withSigner((signer) => clearTotp({ api, uid, signer }), {
        purpose: 'totp',
      });
      if (!result) return;
      if (!result.ok) {
        setError(securityActionErrorText(t, result.code));
        return;
      }
      cancel();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, cancel, onDone, prompt, t, uid]);

  return (
    <Section
      title={t('auth.security.totp')}
      description={
        passkeys.length > 0 ? t('auth.security.totpPasskeyNote') : t('auth.security.totpNote')
      }
    >
      {error ? <Feedback tone="error" text={error} /> : null}
      {ok ? <Feedback tone="ok" text={t('auth.security.totpDone')} /> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={begin} data-testid="security-totp-set">
          {mode.totpEnabled ? t('auth.security.totpReset') : t('auth.security.totpSet')}
        </Button>
        {mode.totpEnabled ? (
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void disable()}
            data-testid="security-totp-clear"
          >
            {t('auth.security.totpClear')}
          </Button>
        ) : null}
      </div>
      {draft ? (
        <div className="flex flex-col items-start gap-2" data-testid="security-totp-uri">
          <p className="text-xs text-muted-foreground">{t('auth.security.totpScanNow')}</p>
          <div className="rounded-lg bg-white p-2">
            <QRCodeSVG value={draft.otpauthUri} size={160} />
          </div>
          <code className="w-full break-all rounded-lg bg-muted p-2 text-[11px]">
            {draft.otpauthUri}
          </code>
          <p className="text-xs text-muted-foreground">{t('auth.security.totpConfirmHint')}</p>
          {/* set-totp 要用 seed 派生 k_totp，passkey 断言给不出 seed：这一步只能要密码。 */}
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={t('auth.security.currentPassword')}
            value={password}
            data-testid="security-totp-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <OtpInput
            value={code}
            onChange={setCode}
            digitLabel={(index, length) => t('auth.totpDigit', { index: index + 1, total: length })}
            data-testid="security-totp-code"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="security-totp-confirm"
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t('auth.security.totpConfirm')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={cancel}
              data-testid="security-totp-cancel"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Passkey
// ---------------------------------------------------------------------------

function PasskeySection({
  mode,
  api,
  uid,
  passkeys,
  prompt,
  listError,
  onDone,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  passkeys: PasskeySummary[];
  prompt: CredentialPromptHandle;
  listError: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await prompt.withSigner(
        (signer) => registerPasskey({ api, uid, name: name || 'passkey', signer }),
        { purpose: 'passkey' }
      );
      if (!result) return;
      if (!result.ok) {
        setError(securityActionErrorText(t, result.code));
        return;
      }
      setName('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, name, onDone, prompt, t, uid]);

  const remove = useCallback(
    async (credentialId: string) => {
      setError(null);
      setBusy(true);
      try {
        const result = await prompt.withSigner(
          (signer) => removePasskey({ api, uid, credentialId, signer }),
          { purpose: 'passkey' }
        );
        if (!result) return;
        if (!result.ok) {
          setError(securityActionErrorText(t, result.code));
          return;
        }
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api, onDone, prompt, t, uid]
  );

  return (
    <Section
      title={t('auth.security.passkeys')}
      description={
        mode.passkeyAvailable
          ? t('auth.security.passkeyNote')
          : t('auth.security.passkeyUnavailable')
      }
    >
      {listError ? (
        <Feedback tone="error" text={t('auth.security.passkeyListFailed', { error: listError })} />
      ) : null}

      {passkeys.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="security-passkey-list">
          {passkeys.map((passkey) => {
            // 本入口用不了的凭证（`usableHere===false`，B2-8）灰掉：它在这里既签不了记录
            // 也登不了录，但仍然要能看见、能删。
            const usable = isPasskeyUsableHere(passkey);
            return (
              <li
                key={passkey.credential_id}
                className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${
                  usable ? 'bg-muted/50' : 'bg-muted/20 opacity-60'
                }`}
                data-usable-here={usable ? 'true' : 'false'}
                data-testid={`security-passkey-row-${passkey.credential_id}`}
              >
                <span className="truncate">
                  {passkey.name || passkey.credential_id}
                  <span className="ml-2 text-muted-foreground">{passkey.origin}</span>
                  {usable ? null : (
                    <span
                      className="ml-2 text-muted-foreground"
                      data-testid={`security-passkey-other-origin-${passkey.credential_id}`}
                    >
                      {t('auth.security.passkeyOtherOrigin')}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  disabled={busy}
                  onClick={() => void remove(passkey.credential_id)}
                  data-testid={`security-passkey-remove-${passkey.credential_id}`}
                >
                  <Trash2 />
                  {t('common.delete')}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Input
        placeholder={t('auth.security.passkeyName')}
        value={name}
        data-testid="security-passkey-name"
        onChange={(event) => setName(event.target.value)}
      />

      {prompt.passkeys.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="security-passkey-signing-note">
          {t('auth.security.signWithExistingPasskey')}
        </p>
      ) : null}

      {error ? <Feedback tone="error" text={error} /> : null}

      <div>
        <Button
          type="button"
          disabled={busy || !mode.passkeyAvailable}
          onClick={() => void add()}
          data-testid="security-passkey-add"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
          {t('auth.security.registerPasskey')}
        </Button>
      </div>
    </Section>
  );
}
