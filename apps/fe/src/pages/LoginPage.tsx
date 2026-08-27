// mesh 登录页（设计 §2「登录页体验」 / §4「身份与入口」）。
// standalone（`/api/auth/mode` 返回 `mode:'none'`）下整页不渲染。

import {
  clearTotpCode,
  establishSessionFromPasskey,
  establishSessionFromPassword,
  loginToAllReachable,
  loginToNode,
  setTotpCode,
} from '@/auth/session-key-store';
import { useAuthMode, useLoginProgress } from '@/auth/use-session-key';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { AlertTriangle, CheckCircle2, Fingerprint, Loader2, ShieldCheck } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

export interface LoginPageProps {
  /** 注入 mode（测试 / 已在外层拉过时用），给了就不再请求 `/api/auth/mode`。 */
  mode?: AuthModeResponse;
  api?: AuthApi;
}

export default function LoginPage({ mode: modeOverride, api = defaultAuthApi }: LoginPageProps) {
  const fetched = useAuthMode(api, { enabled: !modeOverride });
  const mode = modeOverride ?? fetched.mode;

  if (!modeOverride && fetched.loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  // standalone 或 mode 拉取失败：不渲染任何登录 UI。
  if (!mode || mode.mode === 'none') {
    return null;
  }

  return <LoginForm mode={mode} api={api} />;
}

interface LoginFormProps {
  mode: AuthModeResponse;
  api: AuthApi;
}

function LoginForm({ mode, api }: LoginFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const progress = useLoginProgress();

  const nextPath = params.get('next') || '/';
  const targetNode = params.get('node');

  const [username, setUsername] = useState(mode.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'deriving' | 'fanout' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const canUsePasskey = mode.passkeyAvailable && mode.passkeysForThisOrigin;

  // `login.uid` / `delegation.uid` / k_totp 的 HKDF info 用的都是 **user id**，
  // 输入框里的是用户名——只有在与 mode 返回的用户名一致时才能安全地换成 uid。
  const resolveUid = useCallback((): string => {
    if (mode.uid && (!mode.username || username === mode.username)) return mode.uid;
    return username;
  }, [mode.uid, mode.username, username]);

  useEffect(() => {
    if (phase === 'done') {
      navigate(nextPath, { replace: true });
    }
  }, [phase, navigate, nextPath]);

  const runFanOut = useCallback(async () => {
    setPhase('fanout');
    if (targetNode) {
      const result = await loginToNode(targetNode, { api });
      clearTotpCode();
      if (!result.ok) {
        setError(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
        setPhase('idle');
        return;
      }
      setPhase('done');
      return;
    }
    const rows = await loginToAllReachable({ api });
    if (rows.length > 0 && rows.every((row) => row.status === 'error')) {
      setError(t('auth.login.allNodesFailed'));
      setPhase('idle');
      return;
    }
    setPhase('done');
  }, [api, t, targetNode]);

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setError(null);
      if (!username || !password) {
        setError(t('auth.login.credentialsRequired'));
        return;
      }
      if (mode.totpEnabled && !totp) {
        setError(t('auth.login.totpRequired'));
        return;
      }
      if (!mode.kdfParams) {
        setError(t('auth.errors.UNKNOWN_USER'));
        return;
      }
      setBusy(true);
      setPhase('deriving');
      try {
        await establishSessionFromPassword({
          password,
          kdfParams: mode.kdfParams,
          uid: resolveUid(),
          entryNodeId: mode.nodeId,
          rootEpoch: mode.rootEpoch ?? 0,
          hasTotp: Boolean(mode.totpEnabled),
          totpCode: totp || undefined,
        });
        // 密码与验证码用完即清，不留在 React state 里。
        setPassword('');
        setTotp('');
        if (mode.totpEnabled && totp) setTotpCode(totp);
        await runFanOut();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('idle');
      } finally {
        setBusy(false);
      }
    },
    [busy, mode, password, resolveUid, runFanOut, t, totp, username]
  );

  const onPasskey = useCallback(async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    setPhase('deriving');
    try {
      // credentialId 交给 entry 下发的 allowCredentials 决定。
      await establishSessionFromPasskey({
        uid: resolveUid(),
        entryNodeId: mode.nodeId,
        api,
      });
      await runFanOut();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      setError(
        code ? t(`auth.errors.${code}`, { defaultValue: code }) : ((err as Error)?.message ?? '')
      );
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  }, [api, busy, mode.nodeId, resolveUid, runFanOut, t]);

  return (
    <div className="flex min-h-full items-center justify-center p-4" data-testid="login-page">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border bg-background p-6"
        onSubmit={(event) => void onSubmit(event)}
      >
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-4" />
            {t('auth.login.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('auth.login.subtitle')}</p>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label className="text-muted-foreground" htmlFor="login-username">
            {t('auth.login.username')}
          </label>
          <Input
            id="login-username"
            value={username}
            autoComplete="username"
            data-testid="login-username"
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <label className="text-muted-foreground" htmlFor="login-password">
            {t('auth.login.password')}
          </label>
          <Input
            id="login-password"
            type="password"
            value={password}
            autoComplete="current-password"
            data-testid="login-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {mode.totpEnabled ? (
          <div className="flex flex-col gap-1 text-sm">
            <label className="text-muted-foreground" htmlFor="login-totp">
              {t('auth.login.totp')}
            </label>
            <Input
              id="login-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              placeholder="000000"
              data-testid="login-totp"
              onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 8))}
            />
          </div>
        ) : null}

        {error ? (
          <p
            className="flex items-start gap-1.5 text-sm text-destructive"
            data-testid="login-error"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <Button type="submit" disabled={busy} data-testid="login-submit">
          {busy ? <Loader2 className="animate-spin" /> : null}
          {phase === 'deriving'
            ? t('auth.login.deriving')
            : phase === 'fanout'
              ? t('auth.login.signingIn')
              : t('auth.login.submit')}
        </Button>

        {canUsePasskey ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="login-passkey"
            onClick={() => void onPasskey()}
          >
            <Fingerprint />
            {t('auth.login.usePasskey')}
          </Button>
        ) : null}

        <Link
          to="/account/security"
          className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
          data-testid="login-register-passkey"
        >
          {t('auth.login.registerPasskeyHere')}
        </Link>

        {progress.length > 0 ? (
          <ul
            className="flex flex-col gap-1 border-t border-border pt-3"
            data-testid="login-progress"
          >
            {progress.map((row) => (
              <li key={row.nodeId} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{row.nodeName || row.nodeId}</span>
                {row.status === 'pending' ? (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                ) : row.status === 'ok' ? (
                  <CheckCircle2 className="size-3 text-emerald-500" />
                ) : (
                  <span className="truncate text-destructive">
                    {t(`auth.errors.${row.code}`, { defaultValue: row.code ?? '' })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </form>
    </div>
  );
}

export const PageTitle = () => {
  const { t } = useTranslation();
  return <>{t('auth.login.title')}</>;
};

/** 供 F4-2 的路由表挂载：`{ path: 'login', element: <LoginPage /> }`。 */
export const loginRoute = {
  path: 'login',
  moduleLoader: () => import('./LoginPage'),
} as const;
