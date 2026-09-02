// 账号安全面板（右侧滑出，`?panel=security`）：改密、TOTP、passkey。
//
// 原先是 `/account/security` 整页。做成面板后不再打断当前页面，也不必再为它单独留一条
// 无侧栏路由；`standalone`（`mode==='none'`）下整块返回 null，入口本身也不会出现。

import {
  type TotpSetupDraft,
  beginTotpSetup,
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
import { useAuthMode } from '@/auth/use-session-key';
import type {
  AuthApi,
  AuthKdfParamsJson,
  AuthModeResponse,
  PasskeySummary,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Checkbox } from '@tmex/ui/checkbox';
import { Input } from '@tmex/ui/input';
import { OtpInput } from '@tmex/ui/otp-input';
import { AlertTriangle, Fingerprint, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type PasswordChangeFeedback,
  securityActionErrorText,
  submitPasswordChange,
} from './account-security-password';

// 面板的调用方（与单测）沿用同一个入口，改密逻辑本身在 `./account-security-password`。
export {
  type PasswordChangeFollowUp,
  finishPasswordChange,
  passwordChangeFollowUp,
  securityActionErrorText,
} from './account-security-password';

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
        nodeId: mode.nodeId,
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
    mode.nodeId,
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
