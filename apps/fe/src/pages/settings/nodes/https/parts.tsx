// HTTPS 区块内部共用的展示件（与 setup/ 的同类件刻意各自独立，两者文件范围不同）。

import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { CircleCheck, CircleX, Copy, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyLabel, useCopyToClipboard } from '../copy-feedback';

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

export function Notice({
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

export function Field({
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
    <div className="space-y-1.5">
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

export function InfoRow({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-xs" data-testid={testId}>
        {children}
      </span>
    </div>
  );
}

/** 监听端口 / 绑定地址：契约要求前端只给文字提示，绝不自动探测。 */
export function ListenerFields({
  port,
  bindHost,
  portError,
  hostError,
  disabled,
  idPrefix,
  onPortChange,
  onBindHostChange,
}: {
  port: string;
  bindHost: string;
  portError?: string;
  hostError?: string;
  disabled: boolean;
  idPrefix: string;
  onPortChange: (value: string) => void;
  onBindHostChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        id={`${idPrefix}-port`}
        label={t('nodes.https.port')}
        hint={t('nodes.https.portHint')}
        {...(portError ? { error: portError } : {})}
      >
        <Input
          id={`${idPrefix}-port`}
          data-testid={`${idPrefix}-port`}
          inputMode="numeric"
          value={port}
          disabled={disabled}
          onChange={(event) => onPortChange(event.target.value)}
        />
      </Field>
      <Field
        id={`${idPrefix}-bind-host`}
        label={t('nodes.https.bindHost')}
        hint={t('nodes.https.bindHostHint')}
        {...(hostError ? { error: hostError } : {})}
      >
        <Input
          id={`${idPrefix}-bind-host`}
          data-testid={`${idPrefix}-bind-host`}
          value={bindHost}
          disabled={disabled}
          onChange={(event) => onBindHostChange(event.target.value)}
        />
      </Field>
    </div>
  );
}

export function CopyableCode({ value, testId }: { value: string; testId: string }) {
  const { copied, copy } = useCopyToClipboard(value);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code
        className="min-w-0 break-all rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]"
        data-testid={testId}
      >
        {value}
      </code>
      <Button type="button" size="xs" variant="ghost" onClick={copy} data-testid={`${testId}-copy`}>
        {copied ? <CircleCheck className="tmex-scale-in" /> : <Copy className="tmex-scale-in" />}
        <CopyLabel copied={copied} />
      </Button>
    </span>
  );
}
