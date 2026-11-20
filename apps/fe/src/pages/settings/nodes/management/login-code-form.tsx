// 「登录命令」第一步：选目标、选验证方式、输入验证。纯展示，状态由对话框持有。

import type { LoginCodeContext, LoginCodeSkipReason } from '@/auth/login-code-issue';
import { Input } from '@vibeterm/ui/input';
import { OtpInput } from '@vibeterm/ui/otp-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { Tabs, TabsList, TabsTrigger, pillTabTriggerClassName } from '@vibeterm/ui/tabs';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type LoginCodeDraft, activeProofKind, hasProofSwitch } from './login-code-draft';

const NS = 'nodes.loginCode';

export interface LoginCodeNodeOption {
  meshId: string;
  name: string;
  /** null = 可选；否则禁用并在行尾标出原因。 */
  reason: LoginCodeSkipReason | null;
}

export interface LoginCodeFormProps {
  context: LoginCodeContext;
  draft: LoginCodeDraft;
  onDraft: (patch: Partial<LoginCodeDraft>) => void;
  options: LoginCodeNodeOption[];
  /** 指定节点时生效的 mesh id（已套用默认与可用性过滤）。 */
  selectedIds: string[];
  targetCount: number;
  skippedCount: number;
  busy: boolean;
  /** 每次验证码类失败自增，触发验证码框重新聚焦。 */
  focusSeq: number;
}

function Field({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {id ? (
        <label className="text-muted-foreground" htmlFor={id}>
          {label}
        </label>
      ) : (
        <span className="text-muted-foreground">{label}</span>
      )}
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  items,
  onChange,
  disabled,
  testId,
  ariaLabel,
}: {
  value: T;
  items: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  testId: string;
  ariaLabel: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList className="w-full" aria-label={ariaLabel} data-testid={testId}>
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            disabled={disabled}
            className={pillTabTriggerClassName}
            data-testid={`${testId}-${item.value}`}
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function ReasonTag({ reason }: { reason: LoginCodeSkipReason }) {
  const { t } = useTranslation();
  return (
    <span className="ml-auto shrink-0 text-[10px] leading-none text-muted-foreground">
      {t(`${NS}.target.${reason}`)}
    </span>
  );
}

function NodePicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: LoginCodeNodeOption[];
  value: string[];
  onChange: (meshIds: string[]) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  // 一台显示名字，多台只给数量：触发器始终一行。
  const only = value.length === 1 ? options.find((option) => option.meshId === value[0]) : null;
  const summary =
    value.length === 0 ? null : (only?.name ?? t(`${NS}.target.selected`, { count: value.length }));
  return (
    <Select multiple value={value} onValueChange={(next: string[]) => onChange(next)}>
      <SelectTrigger
        className="h-9 w-full"
        aria-label={t(`${NS}.target.some`)}
        disabled={disabled || options.length === 0}
        data-testid="login-code-node"
      >
        <SelectValue>
          {() =>
            summary ? (
              <span className="truncate">{summary}</span>
            ) : (
              <span className="text-muted-foreground">
                {t(options.length === 0 ? 'common.loading' : `${NS}.target.placeholder`)}
              </span>
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.meshId} value={option.meshId} disabled={option.reason !== null}>
            <span className="min-w-0 truncate">{option.name}</span>
            {option.reason ? <ReasonTag reason={option.reason} /> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TargetSection(props: LoginCodeFormProps) {
  const { t } = useTranslation();
  const { draft, onDraft, busy } = props;
  return (
    <Field label={t(`${NS}.target.label`)}>
      <Segmented
        value={draft.scope}
        onChange={(scope) => onDraft({ scope })}
        disabled={busy}
        testId="login-code-scope"
        ariaLabel={t(`${NS}.target.label`)}
        items={[
          { value: 'all', label: t(`${NS}.target.all`) },
          { value: 'some', label: t(`${NS}.target.some`) },
        ]}
      />
      {draft.scope === 'some' ? (
        <NodePicker
          options={props.options}
          value={props.selectedIds}
          onChange={(nodeIds) => onDraft({ nodeIds })}
          disabled={busy}
        />
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="login-code-count">
          {props.targetCount === 0
            ? t(`${NS}.target.none`)
            : t(`${NS}.target.count`, { count: props.targetCount })}
          {props.skippedCount > 0 && (
            <span className="block" data-testid="login-code-skipped">
              {t(`${NS}.target.skipped`, { count: props.skippedCount })}
            </span>
          )}
        </p>
      )}
    </Field>
  );
}

function OtpField({
  label,
  hideLabel,
  labelId,
  value,
  onChange,
  disabled,
  autoFocus,
  focusSeq,
  testId,
}: {
  label: string;
  /** 外层已有「验证」标题时只留给读屏器。 */
  hideLabel?: boolean;
  labelId: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
  focusSeq: number;
  testId: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLFieldSetElement>(null);
  // 验证码被清空后（输错 / 已用过）把焦点放回第一格，直接重输。
  useEffect(() => {
    if (focusSeq > 0) ref.current?.querySelector('input')?.focus();
  }, [focusSeq]);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className={hideLabel ? 'sr-only' : 'text-muted-foreground'} id={labelId}>
        {label}
      </span>
      <OtpInput
        ref={ref}
        value={value}
        onChange={onChange}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-labelledby={labelId}
        digitLabel={(index, length) => t('auth.totpDigit', { index: index + 1, total: length })}
        data-testid={testId}
      />
    </div>
  );
}

function ProofSection(props: LoginCodeFormProps) {
  const { t } = useTranslation();
  const { context, draft, onDraft, busy, focusSeq } = props;
  const kind = activeProofKind(context, draft);
  const otpLabelId = useId();
  const passwordId = useId();
  const passwordOtpLabelId = useId();

  return (
    <Field label={t(`${NS}.proof.label`)}>
      {hasProofSwitch(context) && (
        <Segmented
          value={kind}
          onChange={(proofKind) => onDraft({ proofKind })}
          disabled={busy}
          testId="login-code-proof"
          ariaLabel={t(`${NS}.proof.label`)}
          items={[
            { value: 'totp', label: t(`${NS}.proof.totp`) },
            { value: 'passkey', label: t(`${NS}.proof.passkey`) },
          ]}
        />
      )}
      {kind === 'totp' && (
        <OtpField
          label={t(`${NS}.proof.totp`)}
          hideLabel
          labelId={otpLabelId}
          value={draft.totp}
          onChange={(totp) => onDraft({ totp })}
          disabled={busy}
          autoFocus
          focusSeq={focusSeq}
          testId="login-code-totp"
        />
      )}
      {kind === 'passkey' && (
        <p className="text-xs text-muted-foreground" data-testid="login-code-passkey-hint">
          {t(`${NS}.proof.passkeyHint`)}
        </p>
      )}
      {kind === 'password' && (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground" htmlFor={passwordId}>
              {t(`${NS}.proof.password`)}
            </label>
            <Input
              id={passwordId}
              type="password"
              value={draft.password}
              autoComplete="current-password"
              autoFocus
              disabled={busy}
              onChange={(event) => onDraft({ password: event.target.value })}
              data-testid="login-code-password"
            />
          </div>
          {context.totpEnabled && (
            <OtpField
              label={t(`${NS}.proof.totp`)}
              labelId={passwordOtpLabelId}
              value={draft.passwordTotp}
              onChange={(passwordTotp) => onDraft({ passwordTotp })}
              disabled={busy}
              focusSeq={focusSeq}
              testId="login-code-password-totp"
            />
          )}
        </>
      )}
    </Field>
  );
}

export function LoginCodeForm(props: LoginCodeFormProps) {
  return (
    <div className="flex flex-col gap-4" data-testid="login-code-form">
      <TargetSection {...props} />
      <ProofSection {...props} />
    </div>
  );
}
