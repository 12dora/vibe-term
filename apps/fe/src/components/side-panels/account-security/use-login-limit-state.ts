// 「登录限制」的读写状态：读 `GET /api/auth/login-policy`，保存时经凭据框签一条 `login-policy`。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { setLoginPolicyViaKeyLog } from '@/auth/login-policy-actions';
import { type ApiClient, defaultApiClient } from '@vibeterm/api-client';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { getLoginPolicy } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  type LoginPolicyStatus,
  MIN_LOGIN_POLICY_RECORD_VERSION,
} from '@vibeterm/shared/auth';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { securityActionErrorText } from '../account-security-password';
import {
  type LoginLimitDraft,
  type LoginLimitErrors,
  loginLimitDraft,
  parseLoginLimitDraft,
  policiesEqual,
} from './login-limit-form';
import type { ResolvedMode } from './types';

const NS = 'auth.security.loginLimit';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface LoginLimitStateOptions {
  mode: ResolvedMode;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  /** 读 `GET /api/auth/login-policy` 的客户端；缺省为本机。 */
  client?: ApiClient;
}

export type LoginLimitFeedback = { tone: 'ok' | 'error'; text: string };

export function loginLimitErrorText(t: Translate, code: string): string {
  if (code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) {
    return t(`${NS}.blocked`, { version: MIN_LOGIN_POLICY_RECORD_VERSION });
  }
  return securityActionErrorText(t, code);
}

export function useLoginLimitState({
  mode,
  api,
  prompt,
  client = defaultApiClient,
}: LoginLimitStateOptions) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LoginPolicyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoginLimitDraft | null>(null);
  const [errors, setErrors] = useState<LoginLimitErrors>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<LoginLimitFeedback | null>(null);

  const load = useCallback(() => {
    getLoginPolicy(client)
      .then((next) => {
        setStatus(next);
        setDraft(loginLimitDraft(next.policy));
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError(errorMessage(err)));
  }, [client]);

  useEffect(() => load(), [load]);

  const save = useCallback(async () => {
    if (!draft) return;
    setFeedback(null);
    const parsed = parseLoginLimitDraft(t, draft);
    setErrors(parsed.ok ? {} : parsed.errors);
    if (!parsed.ok) return;
    setBusy(true);
    try {
      const result = await prompt.withSigner(
        (signer) => setLoginPolicyViaKeyLog({ api, mode }, parsed.policy, signer),
        { purpose: 'loginPolicy' }
      );
      if (!result) return;
      setFeedback(
        result.ok
          ? { tone: 'ok', text: t(`${NS}.saved`) }
          : { tone: 'error', text: loginLimitErrorText(t, result.code) }
      );
      // 成功要换成新的生效值；版本门拒绝则重读一次，把待升级的节点列出来。
      if (result.ok || result.code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) load();
    } catch (err) {
      setFeedback({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }, [api, draft, load, mode, prompt, t]);

  const dirty = useMemo(() => {
    if (!status || !draft) return false;
    const parsed = parseLoginLimitDraft(t, draft);
    return !parsed.ok || !policiesEqual(parsed.policy, status.policy);
  }, [draft, status, t]);

  const change = useCallback((next: LoginLimitDraft) => {
    setDraft(next);
    setFeedback(null);
  }, []);

  return { status, loadError, draft, errors, busy, feedback, dirty, save, change };
}
