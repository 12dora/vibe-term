// 登录保护块：当前保护档位的提示条 + 未受保护时的「启用本机登录」表单。
//
// 「直接连接」与「访问控制 → 账号密码」两条路径共用同一块 UI：档位与文案由 `directProtection`
// 单点推导，两处的 testid 保持一致（同一时刻只会渲染其中一处，勾选框 id 不会撞）。

import type { LocalAuthStatus } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, type NoticeTone, SetupNotice } from '../nodes/setup/form-parts';
import {
  type BootstrapDraft,
  type DirectProtection,
  bootstrapDraftError,
  directEnableStage,
  directProtection,
  localAuthErrorKey,
} from './direct-model';
import { bootstrapLocalAuth, localAuthErrorCode, setLocalAuthEnabled } from './local-auth-api';

const PROTECTION_TONE: Record<DirectProtection, NoticeTone> = {
  node: 'success',
  local: 'success',
  unprotected: 'error',
  unknown: 'warning',
};

/** 当前访问保护档位的提示条：受保护 / 未受保护 / 无法确认三种语气由档位决定。 */
export function LoginProtectionNotice({ localAuth }: { localAuth: LocalAuthStatus | null }) {
  const { t } = useTranslation();
  const protection = directProtection(localAuth);
  return (
    <SetupNotice tone={PROTECTION_TONE[protection]} testId={`remote-access-direct-${protection}`}>
      <p className="font-medium">
        {t(`settings.remoteAccess.direct.protection.${protection}.title`)}
      </p>
      <p>{t(`settings.remoteAccess.direct.protection.${protection}.description`)}</p>
    </SetupNotice>
  );
}

export function EnableLocalAuth({
  localAuth,
  onLocalAuth,
}: {
  localAuth: LocalAuthStatus | null;
  onLocalAuth: (next: LocalAuthStatus) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<BootstrapDraft>({
    username: '',
    password: '',
    confirm: '',
  });
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const stage = directEnableStage(localAuth);
  const draftError = stage === 'bootstrap' ? bootstrapDraftError(draft) : null;
  const ready = acknowledged && draftError === null && !pending;

  const submit = async (): Promise<void> => {
    setPending(true);
    setErrorKey(null);
    try {
      // 先建第一位用户再拨开关：无凭证时后端会用 409 `CREDENTIALS_REQUIRED` 拒绝置 true。
      if (stage === 'bootstrap') {
        onLocalAuth(
          await bootstrapLocalAuth({ username: draft.username, password: draft.password })
        );
      }
      onLocalAuth(await setLocalAuthEnabled(true));
    } catch (error) {
      setErrorKey(localAuthErrorKey(localAuthErrorCode(error)));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="remote-access-direct-enable" data-stage={stage}>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground">
        {t('settings.remoteAccess.direct.enable.title')}
      </h4>

      {stage === 'bootstrap' && (
        <BootstrapFields
          draft={draft}
          error={draftError}
          disabled={pending}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        />
      )}

      <SetupNotice tone="warning" testId="remote-access-direct-enable-warning">
        <p>{t('settings.remoteAccess.direct.enable.warning')}</p>
        <label className="flex items-center gap-1.5 font-medium" htmlFor="remote-access-direct-ack">
          <input
            id="remote-access-direct-ack"
            type="checkbox"
            className="size-3.5 shrink-0 accent-current"
            checked={acknowledged}
            disabled={pending}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid="remote-access-direct-ack"
          />
          {t('settings.remoteAccess.direct.enable.acknowledge')}
        </label>
      </SetupNotice>

      {errorKey && (
        <SetupNotice tone="error" testId="remote-access-direct-error">
          {t(errorKey)}
        </SetupNotice>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!ready}
          onClick={() => void submit()}
          data-testid="remote-access-direct-enable-submit"
        >
          {pending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          {t('settings.remoteAccess.direct.enable.action')}
        </Button>
      </div>
    </div>
  );
}

function BootstrapFields({
  draft,
  error,
  disabled,
  onChange,
}: {
  draft: BootstrapDraft;
  error: ReturnType<typeof bootstrapDraftError>;
  disabled: boolean;
  onChange: (patch: Partial<BootstrapDraft>) => void;
}) {
  const { t } = useTranslation();
  // 空表单不报红：只有用户已经写了点什么才提示格式问题。
  const touched = draft.username.length > 0 || draft.password.length > 0;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t('settings.remoteAccess.direct.enable.bootstrapHint')}
      </p>
      <FormField
        id="remote-access-direct-username"
        label={t('settings.remoteAccess.direct.enable.username')}
        hint={t('settings.remoteAccess.direct.enable.usernameHint')}
        error={
          touched && error === 'username'
            ? t('settings.remoteAccess.direct.enable.invalid.username')
            : undefined
        }
      >
        <Input
          id="remote-access-direct-username"
          data-testid="remote-access-direct-username"
          autoComplete="username"
          value={draft.username}
          disabled={disabled}
          onChange={(event) => onChange({ username: event.target.value })}
        />
      </FormField>
      <FormField
        id="remote-access-direct-password"
        label={t('settings.remoteAccess.direct.enable.password')}
        hint={t('settings.remoteAccess.direct.enable.passwordHint')}
        error={
          touched && error === 'password'
            ? t('settings.remoteAccess.direct.enable.invalid.password')
            : undefined
        }
      >
        <Input
          id="remote-access-direct-password"
          data-testid="remote-access-direct-password"
          type="password"
          autoComplete="new-password"
          value={draft.password}
          disabled={disabled}
          onChange={(event) => onChange({ password: event.target.value })}
        />
      </FormField>
      <FormField
        id="remote-access-direct-confirm"
        label={t('settings.remoteAccess.direct.enable.confirm')}
        error={
          touched && error === 'confirm'
            ? t('settings.remoteAccess.direct.enable.invalid.confirm')
            : undefined
        }
      >
        <Input
          id="remote-access-direct-confirm"
          data-testid="remote-access-direct-confirm"
          type="password"
          autoComplete="new-password"
          value={draft.confirm}
          disabled={disabled}
          onChange={(event) => onChange({ confirm: event.target.value })}
        />
      </FormField>
    </div>
  );
}
