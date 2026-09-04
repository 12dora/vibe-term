// 中继的三个租户侧动作：接入（含迁移 / 追加 / 重新输入接入密码）、离开、移除某一条。
//
// 接入必须走根密码（proof 只能由根钥签，见 `relay-enroll.ts`），因此它有自己的表单对话框；
// 另两个只签一条密钥日志记录，凭据走与吊销同一套 `prompt.withSigner`（根密码或通行密钥皆可）。
//
// 所有记录都经 `withKeyLogLock` 提交：与 admit / revoke 抢同一个 key log 头。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { RelayFlowDeps, RelayFlowMode, RelayFlowResult } from '@/node/relay-enroll';
import { enrollRelay, leaveRelay, removeRelay } from '@/node/relay-enroll';
import { forgetRelayPackDebt, rememberRelayPackDebt } from '@/node/relay-meta-key-pending';
import type { RelayPackRefreshResult } from '@/node/relay-pack';
import { refreshRelayPack } from '@/node/relay-pack';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type RelayPendingController, useRelayPending } from './use-relay-pending';
import { readmitErrorText } from './use-relay-readmit';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 接入对话框的四种来意；四者走同一条 `enrollRelay`，差别只在标题与预填地址。 */
export type RelayEnrollIntent = 'enroll' | 'migrate' | 'add' | 'reauth';

/** 需要二次确认的两个动作。 */
export type RelayConfirmIntent = 'leave' | 'remove';

export interface RelayEnrollForm {
  url: string;
  password: string;
  rootPassword: string;
}

export interface RelayConfirmRequest {
  intent: RelayConfirmIntent;
  /** `remove` 要摘掉的那条中继地址。 */
  url?: string;
}

export interface RelayActionsController extends RelayPendingController {
  /** 当前打开的接入对话框；`url` 是预填地址（`reauth` / `migrate` 时锁定）。 */
  enroll: { intent: RelayEnrollIntent; url: string } | null;
  confirm: RelayConfirmRequest | null;
  busy: boolean;
  /** 接入对话框里的行内错误（已本地化）。 */
  error: string | null;
  openEnroll: (intent: RelayEnrollIntent, url?: string) => void;
  closeEnroll: () => void;
  requestConfirm: (intent: RelayConfirmIntent, url?: string) => void;
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

/** 接入失败的行内文案：卡在补签成员那一步时点明是哪一步失败的。 */
function enrollErrorText(t: Translate, result: { code: string; readmit?: unknown }): string {
  return result.readmit
    ? t('nodes.readmit.failed', { error: readmitErrorText(t, result.code) })
    : relayErrorText(t, result.code);
}

function report(t: Translate, result: RelayFlowResult, doneKey: string): boolean {
  if (result.ok) {
    toast.success(t(doneKey));
    return true;
  }
  toast.error(relayErrorText(t, result.code));
  return false;
}

/**
 * 接入后重封的结论落成欠账：逐台回执里失败的那几台精确留账，请求整个没打通时哪几台不明，
 * 整份留账。返回是否全部封上（否则调用方挂一条非阻断告警）。
 */
function settlePackDebt(pack: RelayPackRefreshResult | null): boolean {
  if (pack?.ok) {
    forgetRelayPackDebt();
    return true;
  }
  rememberRelayPackDebt(pack && !pack.transportError ? pack.failed : undefined);
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

  const requestConfirm = useCallback((intent: RelayConfirmIntent, url?: string) => {
    setConfirm(url === undefined ? { intent } : { intent, url });
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
        // 接入成功那一刻手里还有根种子：顺手把密封包封给这台中继，否则它上面一份都没有，
        // 别的机器无法用「租户编号 + 密码」加入。失败不回滚接入，只记欠账并提示。
        // 用容器存：闭包里的赋值 TS 看不见，直接用 let 会被窄化成 null。
        const packRef: { result: RelayPackRefreshResult | null } = { result: null };
        const result = await enrollRelay(flowDeps, {
          url: form.url.trim(),
          password: form.password ? form.password : null,
          rootPassword: form.rootPassword,
          afterEnroll: async (rootKey) => {
            packRef.result = await refreshRelayPack({
              rootSeed: rootKey.seed,
              api: deps.api,
              relayApi,
            });
          },
        });
        if (!result.ok) {
          setError(enrollErrorText(t, result));
          return;
        }
        if (!settlePackDebt(packRef.result)) toast.warning(t('relay.tenant.pack.staleWarning'));
        toast.success(t('relay.tenant.dialog.done'));
        setEnroll(null);
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [deps.api, flowDeps, onChanged, relayApi, t]
  );

  const { prompt } = deps;

  const runConfirm = useCallback(async () => {
    const request = confirm;
    if (!request || !flowDeps) return;
    setBusy(true);
    try {
      // 两个动作都会改变成员的解密能力，凭据走 `withSigner`（不进复用窗口），每次当场确认。
      const result = await prompt.withSigner(
        (signer) => runConfirmAction(flowDeps, request, signer),
        { purpose: 'revoke' }
      );
      if (!result) return;
      if (report(t, result, doneKeyOf(request.intent))) onChanged();
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }, [confirm, flowDeps, onChanged, prompt, t]);

  const pending = useRelayPending({
    api: deps.api,
    relayApi,
    flowDeps,
    prompt,
    onChanged,
    setBusy,
  });

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
    ...pending,
  };
}

function runConfirmAction(
  deps: RelayFlowDeps,
  request: RelayConfirmRequest,
  signer: RecordSigner
): Promise<RelayFlowResult> {
  if (request.intent === 'remove') {
    return request.url
      ? removeRelay(deps, request.url, signer)
      : Promise.resolve({ ok: false as const, code: 'INVALID_URL' });
  }
  return leaveRelay(deps, signer);
}

const DONE_KEYS: Record<RelayConfirmIntent, string> = {
  remove: 'relay.tenant.remove.done',
  leave: 'relay.tenant.leave.done',
};

function doneKeyOf(intent: RelayConfirmIntent): string {
  return DONE_KEYS[intent];
}
