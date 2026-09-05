// 账号安全面板（右侧滑出，`?panel=security`）：改密、TOTP、passkey。
//
// 原先是 `/account/security` 整页。做成面板后不再打断当前页面，也不必再为它单独留一条
// 无侧栏路由；`standalone`（`mode==='none'`）下整块返回 null，入口本身也不会出现。

import { decodeRootPublicKey, useCredentialPrompt } from '@/auth/credential-prompt';
import { useAuthMode } from '@/auth/use-session-key';
import type {
  AuthApi,
  AuthKdfParamsJson,
  AuthModeResponse,
  PasskeySummary,
} from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PasskeySection } from './account-security/passkey-section';
import { PasswordSection } from './account-security/password-section';
import { TotpSection } from './account-security/totp-section';
import type { ResolvedMode, SecurityActionFeedback } from './account-security/types';

// 面板的调用方（与单测）沿用同一个入口，改密逻辑本身在 `./account-security-password`，
// 三个区块在 `./account-security/`。
export {
  type PasswordChangeFollowUp,
  finishPasswordChange,
  passwordChangeFollowUp,
  securityActionErrorText,
} from './account-security-password';
export { PasswordSection };
export type { SecurityActionFeedback };

export interface AccountSecurityPanelProps {
  mode?: AuthModeResponse;
  api?: AuthApi;
}

export type SecurityPanelView = 'pending' | 'empty' | 'content';

/**
 * 面板该渲染什么。
 *
 * 关键在于**刷新期间只要手上还有 mode 就继续渲染内容**：改密成功会 `reload()` 一次
 * `/api/auth/mode`，若这时回落到 spinner，整棵子树连同刚写上的「改密成功」一起被卸载，
 * 用户看到的就是「点完什么都没发生」。
 */
export function securityPanelView(input: {
  loading: boolean;
  mode: AuthModeResponse | null | undefined;
}): SecurityPanelView {
  if (input.mode) return input.mode.mode === 'none' ? 'empty' : 'content';
  return input.loading ? 'pending' : 'empty';
}

export default function AccountSecurityPanel({
  mode: modeOverride,
  api = defaultAuthApi,
}: AccountSecurityPanelProps) {
  const fetched = useAuthMode(api, { enabled: !modeOverride });
  const mode = modeOverride ?? fetched.mode;
  // 反馈提到加载边界之上：各 Section 会因刷新重挂，本地 state 存不住这行字。
  const [feedback, setFeedback] = useState<SecurityActionFeedback | null>(null);
  const view = securityPanelView({ loading: !modeOverride && fetched.loading, mode });

  if (view === 'pending') {
    return (
      <div
        className="flex flex-1 items-center justify-center p-8 text-muted-foreground"
        data-testid="security-panel-pending"
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }
  if (view === 'empty' || !mode) {
    return null;
  }
  return (
    <AccountSecurity
      mode={mode}
      api={api}
      reloadMode={fetched.reload}
      feedback={feedback}
      publishFeedback={setFeedback}
    />
  );
}

interface AccountSecurityProps {
  mode: AuthModeResponse;
  api: AuthApi;
  reloadMode: () => void;
  feedback: SecurityActionFeedback | null;
  publishFeedback: (next: SecurityActionFeedback | null) => void;
}

function AccountSecurity({
  mode: rawMode,
  api,
  reloadMode,
  feedback,
  publishFeedback,
}: AccountSecurityProps) {
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
      <PasswordSection
        mode={mode}
        api={api}
        uid={uid}
        onDone={reloadMode}
        feedback={feedback}
        publishFeedback={publishFeedback}
      />
      <TotpSection
        mode={mode}
        api={api}
        uid={uid}
        passkeys={passkeys}
        prompt={prompt}
        onDone={reloadMode}
        feedback={feedback}
        publishFeedback={publishFeedback}
      />
      <PasskeySection
        mode={mode}
        api={api}
        uid={uid}
        prompt={prompt}
        passkeys={passkeys}
        listError={passkeysError}
        publishFeedback={publishFeedback}
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
