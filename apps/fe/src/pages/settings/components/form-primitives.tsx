// 设置页共用的表单展示原语：提示条、字段外壳、信息行。
//
// nodes/https、nodes/setup、remote-access 三处原本各存一份形状相同的拷贝，这里合成一份；
// 历史上仅有的两处像素差异（字段间距、信息行标签宽度）保留成显式参数，调用方各自指定。

import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

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

/** `tight` 是 https 区块的紧凑排版，`normal` 是向导表单的默认排版。 */
export type FieldSpacing = 'tight' | 'normal';

const FIELD_SPACING: Record<FieldSpacing, string> = {
  tight: 'space-y-1.5',
  normal: 'space-y-2',
};

export interface FormFieldProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  spacing?: FieldSpacing;
  children: ReactNode;
}

export function FormField({
  id,
  label,
  hint,
  error,
  spacing = 'normal',
  children,
}: FormFieldProps) {
  return (
    <div className={FIELD_SPACING[spacing]}>
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

/** 信息行的标签列宽：向导用窄列，https 区块的标签更长用宽列。 */
export type InfoLabelWidth = 'narrow' | 'wide';

const INFO_LABEL_WIDTH: Record<InfoLabelWidth, string> = {
  narrow: 'w-24',
  wide: 'w-28',
};

export interface InfoRowProps {
  label: string;
  testId?: string;
  labelWidth?: InfoLabelWidth;
  children: ReactNode;
}

export function InfoRow({ label, testId, labelWidth = 'wide', children }: InfoRowProps) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={`${INFO_LABEL_WIDTH[labelWidth]} shrink-0 text-xs text-muted-foreground`}>
        {label}
      </span>
      <span className="min-w-0 break-all text-xs" data-testid={testId}>
        {children}
      </span>
    </div>
  );
}
