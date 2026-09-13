// 四条设置路径共用的展示件：通用原语取自 settings/components。

import { PasswordFieldWithGenerate } from '@/components/forms/password-field-with-generate';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Switch } from '@vibeterm/ui/switch';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, Notice } from '../../components/form-primitives';
import type { AddressProbeState } from './address-probe';
import type { RestartWaiter } from './use-restart-waiter';

export { FormField, type NoticeTone } from '../../components/form-primitives';
export { Notice as SetupNotice } from '../../components/form-primitives';

const DIRECT_ENABLE_HINT = {
  hub: {
    supported: 'nodes.setup.fields.directEnableHint',
    unsupported: 'nodes.setup.fields.directUnsupportedHint',
  },
  relay: {
    supported: 'nodes.setup.fields.directEnableRelayHint',
    unsupported: 'nodes.setup.fields.directUnsupportedRelayHint',
  },
} as const;

export function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <label className="block text-sm font-medium" htmlFor={id}>
          {label}
        </label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(Boolean(next))}
        data-testid={id}
      />
    </div>
  );
}

/** 四个设置表单共用的直连开关：平台不支持时禁用并换文案。 */
export function DirectEnableSwitch({
  id,
  checked,
  supported,
  platform,
  kind = 'hub',
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  supported: boolean;
  platform: string;
  kind?: 'hub' | 'relay';
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const hint = DIRECT_ENABLE_HINT[kind];
  return (
    <SwitchRow
      id={id}
      label={t('nodes.setup.fields.directEnable')}
      hint={supported ? t(hint.supported) : t(hint.unsupported, { platform })}
      checked={checked && supported}
      disabled={!supported}
      onCheckedChange={onCheckedChange}
    />
  );
}

/** 加入路径共用的节点名字段。 */
export function NodeNameField({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <FormField
      id={id}
      label={t('nodes.setup.fields.name')}
      hint={t('nodes.setup.fields.nameHint')}
      error={error && t(error)}
    >
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-10"
      />
    </FormField>
  );
}

/** Hub / 中继兼节点共用的账号三件套；id 由调用方给定，以保留各表单既有 testid。 */
export function AccountCredentialFields({
  ids,
  values,
  errors,
  onChange,
}: {
  ids: { username: string; password: string; confirm: string };
  values: { username: string; password: string; confirmPassword: string };
  errors: { username?: string; password?: string; confirmPassword?: string };
  onChange: (patch: {
    username?: string;
    password?: string;
    confirmPassword?: string;
  }) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <FormField
        id={ids.username}
        label={t('nodes.setup.fields.username')}
        hint={t('nodes.setup.fields.usernameHint')}
        error={errors.username && t(errors.username)}
      >
        <Input
          id={ids.username}
          value={values.username}
          onChange={(event) => onChange({ username: event.target.value })}
          autoComplete="username"
          className="min-h-10"
        />
      </FormField>

      <FormField
        id={ids.password}
        label={t('nodes.setup.fields.password')}
        hint={t('nodes.setup.fields.passwordHint')}
        error={errors.password && t(errors.password)}
      >
        <PasswordFieldWithGenerate
          id={ids.password}
          value={values.password}
          onChange={(next) => onChange({ password: next })}
        />
      </FormField>

      <FormField
        id={ids.confirm}
        label={t('nodes.setup.fields.confirmPassword')}
        error={errors.confirmPassword && t(errors.confirmPassword)}
      >
        <Input
          id={ids.confirm}
          type="password"
          value={values.confirmPassword}
          onChange={(event) => onChange({ confirmPassword: event.target.value })}
          autoComplete="new-password"
          className="min-h-10"
        />
      </FormField>
    </>
  );
}

/**
 * 四个设置表单共用的提交行：提交中转圈，被别处的提交锁住时禁用并说明原因。
 * 后端只放行一条设置路径，界面必须同步锁上，否则用户只会拿到一条 409。
 */
export function SetupSubmitRow({
  testId,
  label,
  submitting,
  blocked,
  submitError,
  pendingLabel,
}: {
  /** 表单前缀，如 `setup-join-relay`；按钮与说明条各自补后缀。 */
  testId: string;
  label: string;
  submitting: boolean;
  blocked: boolean;
  submitError?: string | null;
  /** 提交中正在做的具体事（如探测端口）；不给就用通用的「处理中…」。 */
  pendingLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      {submitError && (
        <Notice tone="error" testId={`${testId}-error`}>
          {submitError}
        </Notice>
      )}
      {blocked && (
        <Notice tone="info" testId={`${testId}-blocked`}>
          {t('nodes.setup.transition.blocked')}
        </Notice>
      )}
      <Button type="submit" disabled={submitting || blocked} data-testid={`${testId}-submit`}>
        {submitting && <Loader2 className="animate-spin" />}
        {submitting ? (pendingLabel ?? t('nodes.setup.submit.pending')) : label}
      </Button>
    </>
  );
}

/** 端口探测的三态：在途 / 探到非默认端口并已改写地址 / 全军覆没。 */
export function AddressProbeNotice({
  state,
  kind,
  testId,
}: {
  state: AddressProbeState;
  kind: 'hub' | 'relay';
  testId: string;
}) {
  const { t } = useTranslation();
  if (state.phase === 'idle') return null;
  if (state.phase === 'probing') {
    return (
      <Notice tone="info" testId={`${testId}-probing`}>
        {t('nodes.setup.probe.probing')}
      </Notice>
    );
  }
  if (state.phase === 'failed') {
    return (
      <Notice tone="warning" testId={`${testId}-failed`}>
        {t('nodes.setup.probe.failed')}
      </Notice>
    );
  }
  return (
    <Notice tone="success" testId={`${testId}-resolved`}>
      {t(kind === 'hub' ? 'nodes.setup.probe.resolvedHub' : 'nodes.setup.probe.resolvedRelay', {
        port: state.port,
      })}
    </Notice>
  );
}

export function ResultRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all font-mono text-xs">{value}</span>
    </div>
  );
}

/** 提交成功后的重启进度：等待中 / 已重启 / 超时（给出手动拉起的提示）。 */
export function RestartPanel({ waiter }: { waiter: RestartWaiter }) {
  const { t } = useTranslation();
  if (waiter.state === 'idle') return null;

  if (waiter.state === 'waiting') {
    return (
      <div
        className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
        data-testid="setup-restart-waiting"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        {t('nodes.setup.restart.waiting', { seconds: Math.round(waiter.elapsedMs / 1000) })}
      </div>
    );
  }

  if (waiter.state === 'restarted') {
    return (
      <Notice tone="success" testId="setup-restart-restarted">
        {t('nodes.setup.restart.restarted')}
      </Notice>
    );
  }

  return (
    <Notice tone="warning" testId="setup-restart-timeout">
      <p>{t('nodes.setup.restart.timeout')}</p>
      <p className="font-mono">vibeterm restart</p>
    </Notice>
  );
}

export function directOutcomeLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  outcome: 'enabled' | 'failed' | 'skipped',
  error: string | null
): string {
  if (outcome === 'failed') {
    return t('nodes.setup.result.direct.failed', { error: error ?? '' });
  }
  return t(`nodes.setup.result.direct.${outcome}`);
}
