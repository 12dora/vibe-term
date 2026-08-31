// become-hub / join-hub 两个表单共用的展示件。

import { Switch } from '@tmex/ui/switch';
import { CircleCheck, CircleX, Info, Loader2, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RestartWaiter } from './use-restart-waiter';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const NOTICE_CLASS: Record<NoticeTone, string> = {
  info: 'bg-muted/60 text-muted-foreground',
  success: 'bg-primary/10 text-primary',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  error: 'bg-destructive/10 text-destructive',
};

const NOTICE_ICON: Record<NoticeTone, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
};

export function SetupNotice({
  tone,
  testId,
  children,
}: {
  tone: NoticeTone;
  testId?: string;
  children: ReactNode;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div
      className={`flex items-start gap-1.5 rounded-lg p-2 text-xs ${NOTICE_CLASS[tone]}`}
      data-testid={testId}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p className="text-xs text-destructive" data-testid={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

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
      <SetupNotice tone="success" testId="setup-restart-restarted">
        {t('nodes.setup.restart.restarted')}
      </SetupNotice>
    );
  }

  return (
    <SetupNotice tone="warning" testId="setup-restart-timeout">
      <p>{t('nodes.setup.restart.timeout')}</p>
      <p className="font-mono">tmex restart</p>
    </SetupNotice>
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
