// 中继的三个租户侧动作：接入（含迁移 / 追加 / 重新输入口令）、离开、轮换元数据密钥。
//
// 接入必须走根密码（proof 只能由根钥签，见 `relay-enroll.ts`），因此它有自己的表单对话框；
// 另两个只签一条密钥日志记录，凭据走与吊销同一套 `prompt.withSigner`（根密码或通行密钥皆可）。
//
// 所有记录都经 `withKeyLogLock` 提交：与 admit / revoke 抢同一个 key log 头。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { RelayFlowMode, RelayFlowResult } from '@/node/relay-enroll';
import { appendMetaKey, enrollRelay, leaveRelay } from '@/node/relay-enroll';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 接入对话框的四种来意；四者走同一条 `enrollRelay`，差别只在标题与预填地址。 */
export type RelayEnrollIntent = 'enroll' | 'migrate' | 'add' | 'reauth';

/** 需要二次确认的两个动作。 */
export type RelayConfirmIntent = 'leave' | 'rotate';

export interface RelayEnrollForm {
  url: string;
  password: string;
  rootPassword: string;
}

export interface RelayConfirmRequest {
  intent: RelayConfirmIntent;
}

export interface RelayActionsController {
  /** 当前打开的接入对话框；`url` 是预填地址（`reauth` / `migrate` 时锁定）。 */
  enroll: { intent: RelayEnrollIntent; url: string } | null;
  confirm: RelayConfirmRequest | null;
  busy: boolean;
  /** 接入对话框里的行内错误（已本地化）。 */
  error: string | null;
  openEnroll: (intent: RelayEnrollIntent, url?: string) => void;
  closeEnroll: () => void;
  requestConfirm: (intent: RelayConfirmIntent) => void;
  dismissConfirm: () => void;
  submitEnroll: (form: RelayEnrollForm) => Promise<void>;
  runConfirm: () => Promise<void>;
}

export interface RelayActionsDeps {
  api: AuthApi;
  relayApi?: RelayTenantApi;
  /** 缺 uid / kdf 参数时整族动作不可用。 */
  mode: RelayFlowMode | null;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
}

/**
 * 失败文案：先查中继自己的错误表，查不到再退回通用的 `auth.errors.*`，最后原样显示 code。
 * 中继会把 `RELAY_PASSWORD_INVALID` 这类 code 一路带到浏览器，逐条翻译比堆一句「操作失败」有用。
 */
export function relayErrorText(t: Translate, code: string): string {
  const key = `relay.tenant.errors.${code}`;
  const text = t(key, { defaultValue: '' });
  if (text) return text;
  return t(`auth.errors.${code}`, { defaultValue: code });
}

function report(t: Translate, result: RelayFlowResult, doneKey: string): boolean {
  if (result.ok) {
    toast.success(t(doneKey));
    return true;
  }
  toast.error(relayErrorText(t, result.code));
  return false;
}

export function useRelayActions(deps: RelayActionsDeps): RelayActionsController {
  const { t } = useTranslation();
  const relayApi = deps.relayApi ?? defaultRelayTenantApi;
  const [enroll, setEnroll] = useState<{ intent: RelayEnrollIntent; url: string } | null>(null);
  const [confirm, setConfirm] = useState<RelayConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flowDeps = useMemo(
    () => (deps.mode ? { api: deps.api, relayApi, mode: deps.mode, lock: withKeyLogLock } : null),
    [deps.api, deps.mode, relayApi]
  );

  const openEnroll = useCallback((intent: RelayEnrollIntent, url = '') => {
    setError(null);
    setEnroll({ intent, url });
  }, []);

  const closeEnroll = useCallback(() => {
    setEnroll(null);
    setError(null);
  }, []);

  const requestConfirm = useCallback((intent: RelayConfirmIntent) => {
    setConfirm({ intent });
  }, []);

  const dismissConfirm = useCallback(() => setConfirm(null), []);

  const { onChanged } = deps;

  const submitEnroll = useCallback(
    async (form: RelayEnrollForm) => {
      if (!flowDeps) {
        setError(t('auth.errors.UNKNOWN_USER'));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await enrollRelay(flowDeps, {
          url: form.url.trim(),
          password: form.password ? form.password : null,
          rootPassword: form.rootPassword,
        });
        if (!result.ok) {
          setError(relayErrorText(t, result.code));
          return;
        }
        toast.success(t('relay.tenant.dialog.done'));
        setEnroll(null);
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [flowDeps, onChanged, t]
  );

  const { prompt } = deps;

  const runConfirm = useCallback(async () => {
    const request = confirm;
    if (!request || !flowDeps) return;
    setBusy(true);
    try {
      // 两个动作都会改变成员的解密能力，凭据走 `withSigner`（不进复用窗口），每次当场确认。
      const result = await prompt.withSigner(
        (signer) =>
          request.intent === 'rotate'
            ? appendMetaKey(flowDeps, { op: 'rotate' }, signer)
            : leaveRelay(flowDeps, signer),
        { purpose: 'revoke' }
      );
      if (!result) return;
      if (report(t, result, doneKeyOf(request.intent))) onChanged();
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }, [confirm, flowDeps, onChanged, prompt, t]);

  return {
    enroll,
    confirm,
    busy,
    error,
    openEnroll,
    closeEnroll,
    requestConfirm,
    dismissConfirm,
    submitEnroll,
    runConfirm,
  };
}

function doneKeyOf(intent: RelayConfirmIntent): string {
  return intent === 'rotate' ? 'relay.tenant.metaKey.done' : 'relay.tenant.leave.done';
}
