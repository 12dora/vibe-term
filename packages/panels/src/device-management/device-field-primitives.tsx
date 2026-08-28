// 设备表单字段共用件：字段 id 约定、分区标题与字段标签。

import type { ReactNode } from 'react';
import type { DeviceFormValues } from './device-form';
import type { DeviceDialogMode } from './use-device-dialog-submit';

export interface DeviceFieldsProps {
  mode: DeviceDialogMode;
  values: DeviceFormValues;
  attempted: boolean;
  onChange: (patch: Partial<DeviceFormValues>) => void;
}

export function deviceFieldId(mode: DeviceDialogMode, suffix: string): string {
  return `${mode}-device-${suffix}`;
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export function FieldLabel({
  htmlFor,
  text,
  required,
}: {
  htmlFor: string;
  text: string;
  required?: boolean;
}) {
  return (
    <label className="block text-xs font-medium text-foreground" htmlFor={htmlFor}>
      {text}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  );
}
