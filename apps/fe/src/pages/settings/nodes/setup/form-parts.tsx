// become-hub / join-hub 两个表单共用的展示件：通用原语取自 settings/components。

import { Switch } from '@tmex/ui/switch';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../components/form-primitives';
import type { RestartWaiter } from './use-restart-waiter';

export { FormField, type NoticeTone } from '../../components/form-primitives';
export { Notice as SetupNotice } from '../../components/form-primitives';

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
      <Notice tone="success" testId="setup-restart-restarted">
        {t('nodes.setup.restart.restarted')}
      </Notice>
    );
  }

  return (
    <Notice tone="warning" testId="setup-restart-timeout">
      <p>{t('nodes.setup.restart.timeout')}</p>
      <p className="font-mono">tmex restart</p>
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
