// mesh 登录页（设计 §2「登录页体验」 / §4「身份与入口」）。
// standalone（`/api/auth/mode` 返回 `mode:'none'`）下整页不渲染。
//
// 页面上只有：品牌、用户名、密码、验证码（开了 TOTP 才有）、登录、用通行密钥登录，外加一行错误。
// 内部状态（会登录哪些节点、逐台的 fan-out 进度、会话钥怎么用）不出现在界面上；passkey 的
// **注册**入口只在「账号安全」里，这里只有**用 passkey 登录**。
//
// 通行密钥按钮只要当前地址支持（HTTPS / localhost）就一直在——按「本 origin 已注册过」来藏它，
// 等于没人发现得了这个功能；没注册的情况在点击时给出下一步，不可用的地址给一行说明。

import {
  isCredentialFailure,
  loginErrorKey,
  loginErrorKeyFromException,
} from '@/auth/login-errors';
import {
  clearSessionKey,
  clearTotpCode,
  ensureNodeLogin,
  setTotpCode,
} from '@/auth/session-key-store';
import {
  establishSessionFromPasskey,
  establishSessionFromPassword,
  loginSelf,
} from '@/auth/session-login';
import { useAuthMode } from '@/auth/use-session-key';
import { Brand } from '@/components/brand';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi, isWebAuthnAvailable, requireRootEpoch } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { OtpInput } from '@tmex/ui/otp-input';
import { AlertTriangle, Fingerprint, Loader2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

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
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
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

export type Phase = 'idle' | 'deriving' | 'signingIn' | 'done';

/** 「使用通行密钥」这一栏渲染成什么：按钮 / 一行不可用说明 / 什么都不给。 */
export type PasskeyAffordance = 'button' | 'unavailable' | 'none';

/**
 * 按钮**不**依赖本 origin 是否已注册过通行密钥——藏起来等于没人发现得了这个功能。
 * 浏览器压根不支持 WebAuthn 时才整栏不出现，说明「需要 HTTPS」只会让人更糊涂。
 */
export function passkeyAffordance(
  mode: Pick<AuthModeResponse, 'passkeyAvailable'>,
  webauthnSupported: boolean = isWebAuthnAvailable()
): PasskeyAffordance {
  if (!webauthnSupported) return 'none';
  return mode.passkeyAvailable ? 'button' : 'unavailable';
}

/** 点按钮时的前置判定：返回文案 key 表示不进入 WebAuthn 仪式。 */
export function passkeyBlockReason(
  mode: Pick<AuthModeResponse, 'passkeysForThisOrigin'>
): string | null {
  return mode.passkeysForThisOrigin ? null : 'auth.login.passkeyNotRegistered';
}

/** 「使用通行密钥」的动作：前置判定没过就只回文案 key，绝不发起 WebAuthn 仪式。成功回 null。 */
export async function attemptPasskeyLogin(args: {
  mode: AuthModeResponse;
  uid: string;
  api: AuthApi;
}): Promise<string | null> {
  const blocked = passkeyBlockReason(args.mode);
  if (blocked) return blocked;
  try {
    // credentialId 交给 entry 下发的 allowCredentials 决定。
    await establishSessionFromPasskey({
      uid: args.uid,
      entryNodeId: args.mode.nodeId,
      api: args.api,
    });
    return null;
  } catch (err) {
    return loginErrorKeyFromException(err, 'passkey');
  }
}

export interface PasskeyLoginDeps {
  mode: AuthModeResponse;
  uid: string;
  api: AuthApi;
  /** 会话钥建好之后的最后一步：登录本机或 `?node=` 指定的那台。 */
  finishLogin: (method: 'passkey') => Promise<void>;
  setPhase: (phase: Phase) => void;
  /** 只回文案 key，`t()` 留给组件。 */
  onErrorKey: (key: string) => void;
}

/**
 * 通行密钥登录的完整编排。收尾这一步（节点签名、会话钥落盘）同样会抛，必须和仪式
 * 一起裹在同一个 try 里：漏在外面就是一个 unhandled rejection，页面停在「登录中」
 * 且一行错误都没有。
 */
export async function runPasskeyLogin(deps: PasskeyLoginDeps): Promise<void> {
  deps.setPhase('deriving');
  try {
    const errorKey = await attemptPasskeyLogin({ mode: deps.mode, uid: deps.uid, api: deps.api });
    if (errorKey) {
      deps.onErrorKey(errorKey);
      deps.setPhase('idle');
      return;
    }
    await deps.finishLogin('passkey');
  } catch (err) {
    deps.onErrorKey(loginErrorKeyFromException(err, 'passkey'));
    deps.setPhase('idle');
  }
}

function PasskeyRow({
  affordance,
  busy,
  onClick,
}: {
  affordance: PasskeyAffordance;
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (affordance === 'none') return null;
  if (affordance === 'unavailable') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="login-passkey-unavailable">
        {t('auth.login.passkeyUnavailable')}
      </p>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      data-testid="login-passkey"
      onClick={onClick}
    >
      <Fingerprint />
      {t('auth.login.usePasskey')}
    </Button>
  );
}

// `login.uid` / `delegation.uid` / k_totp 的 HKDF info 用的都是 **user id**，
// 输入框里的是用户名——只有在与 mode 返回的用户名一致时才能安全地换成 uid。
function resolveLoginUid(mode: AuthModeResponse, username: string): string {
  if (mode.uid && (!mode.username || username === mode.username)) return mode.uid;
  return username;
}

function LoginForm({ mode, api }: LoginFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const nextPath = params.get('next') || '/';
  /** `?node=` 是「去登录这一台」的显式入口（多半来自「登录此节点」按钮），必须等它完成。 */
  const targetNode = params.get('node');

  const [username, setUsername] = useState(mode.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const affordance = passkeyAffordance(mode);

  const resolveUid = useCallback(() => resolveLoginUid(mode, username), [mode, username]);

  useEffect(() => {
    if (phase === 'done') {
      navigate(nextPath, { replace: true });
    }
  }, [phase, navigate, nextPath]);

  /**
   * 会话钥已经建好之后的最后一步。
   *
   * 没有 `?node=` 时**只登录本机**：成功即跳转，其余节点等用户真的要用它时由
   * `ensureNodeLogin()` 静默登录（`/n/:id` 路由或侧边栏展开）。
   */
  const finishLogin = useCallback(
    async (method: 'password' | 'passkey') => {
      setPhase('signingIn');
      const result = targetNode
        ? await ensureNodeLogin(targetNode, { api })
        : await loginSelf({ api });
      if (targetNode) clearTotpCode();
      if (result.ok) {
        setPhase('done');
        return;
      }
      // 凭证本身不可用才丢钥；网络错误 / 验证码错留着钥，用户重试即可。
      // 等盘上那份删干净再放用户重试：中途刷新不该把作废的会话钥恢复回来。
      if (isCredentialFailure(result.code)) await clearSessionKey();
      setError(t(loginErrorKey(result.code, method)));
      setPhase('idle');
    },
    [api, t, targetNode]
  );

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setError(null);
      if (!username || !password) {
        setError(t('auth.login.credentialsRequired'));
        return;
      }
      if (mode.totpEnabled && totp.length !== 6) {
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
        // rootEpoch 缺失即协议不兼容：按 0 派生 k_totp 会在 rotate 过根钥后把账号远程锁死。
        const rootEpoch = requireRootEpoch(mode);
        await establishSessionFromPassword({
          password,
          kdfParams: mode.kdfParams,
          uid: resolveUid(),
          entryNodeId: mode.nodeId,
          rootEpoch,
          hasTotp: Boolean(mode.totpEnabled),
          totpCode: totp || undefined,
        });
        // 密码与验证码用完即清，不留在 React state 里。
        setPassword('');
        setTotp('');
        if (mode.totpEnabled && totp) setTotpCode(totp);
        await finishLogin('password');
      } catch (err) {
        setError(t(loginErrorKeyFromException(err, 'password')));
        setPhase('idle');
      } finally {
        setBusy(false);
      }
    },
    [busy, finishLogin, mode, password, resolveUid, t, totp, username]
  );

  const onPasskey = useCallback(async () => {
    if (busy) return;
    setError(null);
    // 这个 origin 一个通行密钥都没有：直接给出下一步，别把用户丢进注定失败的系统弹窗。
    const blocked = passkeyBlockReason(mode);
    if (blocked) {
      setError(t(blocked));
      return;
    }
    setBusy(true);
    try {
      await runPasskeyLogin({
        mode,
        uid: resolveUid(),
        api,
        finishLogin,
        setPhase,
        onErrorKey: (key) => setError(t(key)),
      });
    } finally {
      setBusy(false);
    }
  }, [api, busy, finishLogin, mode, resolveUid, t]);

  return (
    <div className="flex min-h-full items-center justify-center p-4" data-testid="login-page">
      <form
        className="tmex-reveal flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border bg-background p-6"
        onSubmit={(event) => void onSubmit(event)}
      >
        <Brand className="justify-center" />

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
            {/* 六个单字符格子没有单一的可关联控件，标题走 aria-labelledby 而不是 <label for>。 */}
            <span className="text-muted-foreground" id="login-totp-label">
              {t('auth.login.totp')}
            </span>
            <OtpInput
              value={totp}
              onChange={setTotp}
              aria-labelledby="login-totp-label"
              digitLabel={(index, length) =>
                t('auth.totpDigit', { index: index + 1, total: length })
              }
              data-testid="login-totp"
            />
          </div>
        ) : null}

        {/* 播报节点必须**一直挂着**：`empty:hidden` 会把它从可访问性树里摘掉，
            读屏拿不到「内容变了」这件事，播报就时灵时不灵。所以这里拆成两半——
            常驻的 sr-only live region 负责播报（absolute 定位，不占 flex gap），
            可见的报错块照旧条件渲染。 */}
        <output className="sr-only" aria-live="polite">
          {error ?? ''}
        </output>
        {error ? (
          <p
            className="tmex-fade flex items-start gap-1.5 text-sm text-destructive"
            data-testid="login-error"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <Button type="submit" disabled={busy} data-testid="login-submit">
          {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
          {phase === 'deriving'
            ? t('auth.login.deriving')
            : phase === 'signingIn'
              ? t('auth.login.signingIn')
              : t('auth.login.submit')}
        </Button>

        <PasskeyRow affordance={affordance} busy={busy} onClick={() => void onPasskey()} />
      </form>
    </div>
  );
}

export const PageTitle = () => {
  const { t } = useTranslation();
  return <>{t('auth.login.title')}</>;
};
