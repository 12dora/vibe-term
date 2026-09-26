// 账号安全面板的「登录限制」：预设三档 + 自定义，保存即签一条 `login-policy` 记录（全网生效）。
// 有节点低于 2.10.0 时记录写不进去：整块只读，列出要先升级的节点。

import {
  LOGIN_POLICY_PRESETS,
  LOGIN_POLICY_PRESET_NAMES,
  type LoginPolicyPreset,
  type LoginPolicyStatus,
  MIN_LOGIN_POLICY_RECORD_VERSION,
} from '@vibeterm/shared/auth';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { Switch } from '@vibeterm/ui/switch';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DURATION_UNITS, type DurationDraft, type DurationUnit } from './duration-field';
import {
  type LoginLimitDraft,
  type LoginLimitErrors,
  presetSummary,
  withPreset,
} from './login-limit-form';
import { Feedback, Section } from './section';
import {
  type LoginLimitFeedback,
  type LoginLimitStateOptions,
  useLoginLimitState,
} from './use-login-limit-state';

export { loginLimitErrorText } from './use-login-limit-state';

const NS = 'auth.security.loginLimit';

export function LoginLimitSection(props: LoginLimitStateOptions) {
  const { t } = useTranslation();
  const state = useLoginLimitState(props);
  const { status, draft, loadError } = state;
  return (
    <Section title={t(`${NS}.title`)} description={t(`${NS}.description`)}>
      <div data-testid="security-login-limit" className="flex flex-col gap-3">
        {loadError ? (
          <Feedback tone="error" text={t(`${NS}.loadFailed`, { error: loadError })} />
        ) : null}
        {!status || !draft ? (
          loadError ? null : (
            <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
          )
        ) : (
          <LoginLimitForm
            status={status}
            draft={draft}
            errors={state.errors}
            busy={state.busy}
            dirty={state.dirty}
            feedback={state.feedback}
            onChange={state.change}
            onSave={() => void state.save()}
          />
        )}
      </div>
    </Section>
  );
}

export interface LoginLimitFormProps {
  status: LoginPolicyStatus;
  draft: LoginLimitDraft;
  errors: LoginLimitErrors;
  busy: boolean;
  dirty: boolean;
  feedback: LoginLimitFeedback | null;
  onChange: (next: LoginLimitDraft) => void;
  onSave: () => void;
}

/** 表单本体（无请求）：单测直接静态渲染它。 */
export function LoginLimitForm({
  status,
  draft,
  errors,
  busy,
  dirty,
  feedback,
  onChange,
  onSave,
}: LoginLimitFormProps) {
  const { t } = useTranslation();
  const locked = !status.writable;
  const disabled = busy || locked;
  return (
    <>
      {locked ? <LoginLimitBlockers status={status} /> : null}
      {status.source === 'default' ? (
        <p className="text-xs text-muted-foreground" data-testid="security-login-limit-default">
          {t(`${NS}.sourceDefault`)}
        </p>
      ) : null}
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">{t(`${NS}.title`)}</legend>
        {LOGIN_POLICY_PRESET_NAMES.map((preset) => (
          <PresetCard
            key={preset}
            preset={preset}
            selected={draft.preset === preset}
            disabled={disabled}
            onSelect={() => onChange(withPreset(draft, preset))}
          />
        ))}
      </fieldset>
      {draft.preset === 'custom' ? (
        <CustomFields draft={draft} errors={errors} disabled={disabled} onChange={onChange} />
      ) : null}
      {errors.form ? <Feedback tone="error" text={errors.form} /> : null}
      <label
        className="flex items-center justify-between gap-3"
        htmlFor="security-login-limit-exempt"
      >
        <span className="min-w-0">
          <span className="block text-sm">{t(`${NS}.exemptLocal`)}</span>
          <span className="block text-xs text-muted-foreground">{t(`${NS}.exemptLocalHint`)}</span>
        </span>
        <Switch
          id="security-login-limit-exempt"
          checked={draft.exemptLocal}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...draft, exemptLocal: checked === true })}
          data-testid="security-login-limit-exempt"
        />
      </label>
      {feedback ? <Feedback tone={feedback.tone} text={feedback.text} /> : null}
      <div>
        <Button
          type="button"
          disabled={disabled || !dirty}
          onClick={onSave}
          data-testid="security-login-limit-save"
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t(`${NS}.save`)}
        </Button>
      </div>
    </>
  );
}

export function LoginLimitBlockers({ status }: { status: LoginPolicyStatus }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="security-login-limit-blocked">
      <Feedback
        tone="error"
        text={t(`${NS}.blocked`, { version: MIN_LOGIN_POLICY_RECORD_VERSION })}
      />
      <ul className="flex flex-col gap-0.5 text-muted-foreground">
        {status.blockers.map((node) => (
          <li
            key={node.nodeId}
            className="truncate"
            data-testid={`security-login-limit-blocker-${node.nodeId}`}
          >
            {node.name} · {node.version ? `v${node.version}` : t(`${NS}.versionUnknown`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PresetCard({
  preset,
  selected,
  disabled,
  onSelect,
}: {
  preset: LoginPolicyPreset;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const summary = preset === 'custom' ? null : presetSummary(t, LOGIN_POLICY_PRESETS[preset]);
  return (
    <label
      className={cn(
        'flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-3 py-2 transition-colors duration-(--vibeterm-motion-fast) ease-out has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 motion-reduce:transition-none',
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
          : 'border-border hover:bg-muted/40'
      )}
      data-testid={`security-login-limit-preset-${preset}`}
      data-selected={selected ? '' : undefined}
    >
      <input
        type="radio"
        name="security-login-limit-preset"
        value={preset}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="text-sm font-medium">{t(`${NS}.preset.${preset}`)}</span>
      {summary ? (
        <>
          <span className="text-[11px] text-muted-foreground">{summary.ip}</span>
          <span className="text-[11px] text-muted-foreground">{summary.account}</span>
        </>
      ) : null}
    </label>
  );
}

function CustomFields({
  draft,
  errors,
  disabled,
  onChange,
}: {
  draft: LoginLimitDraft;
  errors: LoginLimitErrors;
  disabled: boolean;
  onChange: (next: LoginLimitDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" data-testid="security-login-limit-custom">
      <CountField
        id="ipFailThreshold"
        label={t(`${NS}.fields.ipFailThreshold`)}
        value={draft.ipFailThreshold}
        error={errors.ipFailThreshold}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, ipFailThreshold: value })}
      />
      <DurationField
        id="ipLockBase"
        label={t(`${NS}.fields.ipLockBase`)}
        value={draft.ipLockBase}
        error={errors.ipLockBase}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, ipLockBase: value })}
      />
      <DurationField
        id="ipLockMax"
        label={t(`${NS}.fields.ipLockMax`)}
        value={draft.ipLockMax}
        error={errors.ipLockMax}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, ipLockMax: value })}
      />
      <p className="text-xs text-muted-foreground">{t(`${NS}.ladderHint`)}</p>
      <CountField
        id="accountFailPerHour"
        label={t(`${NS}.fields.accountFailPerHour`)}
        value={draft.accountFailPerHour}
        error={errors.accountFailPerHour}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, accountFailPerHour: value })}
      />
      <DurationField
        id="accountLock"
        label={t(`${NS}.fields.accountLock`)}
        value={draft.accountLock}
        error={errors.accountLock}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, accountLock: value })}
      />
    </div>
  );
}

function FieldRow({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs text-muted-foreground" htmlFor={`security-login-limit-${id}`}>
          {label}
        </label>
        <div className="flex items-center gap-1.5">{children}</div>
      </div>
      {error ? <Feedback tone="error" text={error} /> : null}
    </div>
  );
}

function CountField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <FieldRow id={id} label={label} error={error}>
      <Input
        id={`security-login-limit-${id}`}
        inputMode="numeric"
        className="h-8 w-20 text-right"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`security-login-limit-${id}`}
      />
      <span className="w-16 text-xs text-muted-foreground">{t(`${NS}.unit.times`)}</span>
    </FieldRow>
  );
}

function DurationField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: DurationDraft;
  error?: string;
  disabled: boolean;
  onChange: (value: DurationDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <FieldRow id={id} label={label} error={error}>
      <Input
        id={`security-login-limit-${id}`}
        inputMode="numeric"
        className="h-8 w-20 text-right"
        value={value.value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange({ ...value, value: event.target.value })}
        data-testid={`security-login-limit-${id}`}
      />
      <Select
        value={value.unit}
        onValueChange={(next) => next && onChange({ ...value, unit: next as DurationUnit })}
      >
        <SelectTrigger
          size="sm"
          className="w-16"
          disabled={disabled}
          data-testid={`security-login-limit-${id}-unit`}
        >
          <SelectValue>{t(`${NS}.unit.${value.unit}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {DURATION_UNITS.map((unit) => (
            <SelectItem key={unit} value={unit}>
              {t(`${NS}.unit.${unit}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}
