// 账号安全页 `/account/security`：改密、TOTP、passkey。
//
// 为什么独立成页而不是塞进「系统设置」的 tab：设计 §4 把「账号安全」放在 Nodes 页（F4-3 负责）
// 的一个区块里，而 SettingsPage 的 tab 列表属于 F4-2 的改造范围。做成独立页后两边都只需要
// 一个链接即可复用，且 standalone 下整页返回 null，不会在设置里留一个空 tab。

import {
  type TotpSetupDraft,
  beginTotpSetup,
  changePassword,
  clearTotp,
  confirmTotpSetup,
  passkeysForOrigin,
  registerPasskey,
  removePasskey,
  withRootSigner,
} from '@/auth/account-security-actions';
import type { RecordSigner } from '@/auth/key-log-actions';
import { clearSessionKey } from '@/auth/session-key-store';
import { useAuthMode } from '@/auth/use-session-key';
import type {
  AuthApi,
  AuthKdfParamsJson,
  AuthModeResponse,
  PasskeySummary,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { AlertTriangle, Fingerprint, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface AccountSecurityPageProps {
  mode?: AuthModeResponse;
  api?: AuthApi;
}

export default function AccountSecurityPage({
  mode: modeOverride,
  api = defaultAuthApi,
}: AccountSecurityPageProps) {
  const fetched = useAuthMode(api, { enabled: !modeOverride });
  const mode = modeOverride ?? fetched.mode;

  if (!modeOverride && fetched.loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
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

function Feedback({ tone, text }: { tone: 'error' | 'ok'; text: string }) {
  return (
    <p
      className={`text-xs ${tone === 'error' ? 'text-destructive' : 'text-emerald-500'}`}
      data-testid={`security-${tone}`}
    >
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

  if (!rawMode.uid || !rawMode.kdfParams) {
    return (
      <div className="mx-auto w-full max-w-3xl p-5 text-sm text-muted-foreground">
        {t('auth.errors.UNKNOWN_USER')}
      </div>
    );
  }
  const mode: ResolvedMode = { ...rawMode, uid: rawMode.uid, kdfParams: rawMode.kdfParams };
  const uid = mode.uid;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-5">
      <PasswordSection mode={mode} api={api} uid={uid} onDone={reloadMode} />
      <TotpSection mode={mode} api={api} uid={uid} passkeys={passkeys} onDone={reloadMode} />
      <PasskeySection
        mode={mode}
        api={api}
        uid={uid}
        passkeys={passkeys}
        listError={passkeysError}
        onDone={() => {
          reloadPasskeys();
          reloadMode();
        }}
      />
      <p className="px-1 text-xs text-muted-foreground">{t('auth.security.sessionKeyNote')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 改密
// ---------------------------------------------------------------------------

function PasswordSection({
  mode,
  api,
  uid,
  onDone,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const submit = useCallback(async () => {
    setError(null);
    setOk(false);
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
      const result = await changePassword({
        api,
        uid,
        oldPassword,
        newPassword,
        currentKdfParams: mode.kdfParams,
      });
      if (!result.ok) {
        setError(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
        return;
      }
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setOk(true);
      // rotate-root 会撤销所有会话：本地 sk_sess 立刻作废。
      clearSessionKey();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, confirm, mode.kdfParams, newPassword, oldPassword, onDone, t, uid]);

  return (
    <Section title={t('auth.security.changePassword')}>
      <p
        className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        data-testid="password-warning"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('auth.security.changePasswordWarning')}</span>
      </p>
      <Input
        type="password"
        autoComplete="current-password"
        placeholder={t('auth.security.currentPassword')}
        value={oldPassword}
        data-testid="security-old-password"
        onChange={(event) => setOldPassword(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={t('auth.security.newPassword')}
        value={newPassword}
        data-testid="security-new-password"
        onChange={(event) => setNewPassword(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={t('auth.security.confirmPassword')}
        value={confirm}
        data-testid="security-confirm-password"
        onChange={(event) => setConfirm(event.target.value)}
      />
      {error ? <Feedback tone="error" text={error} /> : null}
      {ok ? <Feedback tone="ok" text={t('auth.security.changePasswordDone')} /> : null}
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
  onDone,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  passkeys: PasskeySummary[];
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
    if (!/^\d{6,8}$/.test(code.trim())) {
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
        setError(t(`auth.errors.${outcome.result.code}`, { defaultValue: outcome.result.code }));
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

  const disable = useCallback(async () => {
    setError(null);
    setOk(false);
    if (!password) {
      setError(t('auth.security.passwordRequired'));
      return;
    }
    setBusy(true);
    try {
      const result = await withRootSigner(password, mode.kdfParams, (signer) =>
        clearTotp({ api, uid, signer })
      );
      setPassword('');
      if (!result.ok) {
        setError(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
        return;
      }
      cancel();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, cancel, mode.kdfParams, onDone, password, t, uid]);

  return (
    <Section
      title={t('auth.security.totp')}
      description={
        passkeys.length > 0 ? t('auth.security.totpPasskeyNote') : t('auth.security.totpNote')
      }
    >
      <Input
        type="password"
        autoComplete="current-password"
        placeholder={t('auth.security.currentPassword')}
        value={password}
        data-testid="security-totp-password"
        onChange={(event) => setPassword(event.target.value)}
      />
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
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            value={code}
            data-testid="security-totp-code"
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
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
  listError,
  onDone,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  passkeys: PasskeySummary[];
  listError: string | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [signWithPasskey, setSignWithPasskey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 只有注册 origin 与当前 origin 一致的 passkey 才能在这里发起断言。
  const usable = useMemo(() => passkeysForOrigin(passkeys), [passkeys]);

  /**
   * 签一条记录：passkey 分支从 `usable` 里取（不是列表第一把），
   * 根钥分支走 `withRootSigner`，签完立刻清零 seed。
   */
  const runSigned = useCallback(
    async <T,>(fn: (signer: RecordSigner) => Promise<T>): Promise<T> => {
      if (signWithPasskey) {
        if (usable.length === 0) throw new Error(t('auth.errors.PASSKEY_CREDENTIAL_UNKNOWN'));
        return fn({ kind: 'passkey', credentialId: usable[0].credential_id });
      }
      if (!password) throw new Error(t('auth.security.passwordRequired'));
      return withRootSigner(password, mode.kdfParams, fn);
    },
    [mode.kdfParams, password, signWithPasskey, t, usable]
  );

  const add = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await runSigned((signer) =>
        registerPasskey({ api, uid, name: name || 'passkey', signer })
      );
      setPassword('');
      if (!result.ok) {
        setError(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
        return;
      }
      setName('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, name, onDone, runSigned, t, uid]);

  const remove = useCallback(
    async (credentialId: string) => {
      setError(null);
      setBusy(true);
      try {
        const result = await runSigned((signer) =>
          removePasskey({ api, uid, credentialId, signer })
        );
        setPassword('');
        if (!result.ok) {
          setError(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
          return;
        }
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [api, onDone, runSigned, t, uid]
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
          {passkeys.map((passkey) => (
            <li
              key={passkey.credential_id}
              className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
            >
              <span className="truncate">
                {passkey.name || passkey.credential_id}
                <span className="ml-2 text-muted-foreground">{passkey.origin}</span>
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
          ))}
        </ul>
      ) : null}

      <Input
        placeholder={t('auth.security.passkeyName')}
        value={name}
        data-testid="security-passkey-name"
        onChange={(event) => setName(event.target.value)}
      />

      {usable.length > 0 && mode.passkeyAvailable ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={signWithPasskey}
            data-testid="security-sign-with-passkey"
            onChange={(event) => setSignWithPasskey(event.target.checked)}
          />
          {t('auth.security.signWithExistingPasskey')}
        </label>
      ) : null}

      {signWithPasskey ? null : (
        <Input
          type="password"
          autoComplete="current-password"
          placeholder={t('auth.security.currentPassword')}
          value={password}
          data-testid="security-passkey-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      )}

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

export const PageTitle = () => {
  const { t } = useTranslation();
  return <>{t('auth.security.title')}</>;
};

/** 供 F4-2 的路由表挂载：`{ path: 'account/security', element: <AccountSecurityPage /> }`。 */
export const accountSecurityRoute = {
  path: 'account/security',
  moduleLoader: () => import('./AccountSecurityPage'),
} as const;
