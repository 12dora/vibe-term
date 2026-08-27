// 设备基础字段：名称、类型、tmux session、默认工作目录。

import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { useTranslation } from 'react-i18next';
import {
  type DeviceFieldsProps,
  FieldLabel,
  SectionHeading,
  deviceFieldId,
} from './device-field-primitives';
import type { DeviceFormValues } from './device-form';

function nextAuthModeForType(
  values: DeviceFormValues,
  nextType: DeviceFormValues['type']
): DeviceFormValues['authMode'] {
  if (nextType === 'local') return 'auto';
  return values.authMode === 'auto' ? 'agent' : values.authMode;
}

function DeviceTypeSelect({ mode, values, onChange }: Omit<DeviceFieldsProps, 'attempted'>) {
  const { t } = useTranslation();
  const selectId = deviceFieldId(mode, 'type');
  const typeLabels: Record<string, string> = {
    local: t('device.typeLocal'),
    ssh: t('device.typeSSH'),
  };

  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={selectId} text={t('device.type')} />
      <Select
        value={values.type}
        onValueChange={(nextValue) => {
          if (!nextValue) return;
          const nextType = nextValue as DeviceFormValues['type'];
          onChange({ type: nextType, authMode: nextAuthModeForType(values, nextType) });
        }}
        disabled={mode === 'edit'}
      >
        <SelectTrigger id={selectId} data-testid="device-type-select" className="w-full">
          <SelectValue placeholder={t('device.type')}>
            {(value) => typeLabels[value as string] ?? ''}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{t('device.typeLocal')}</SelectItem>
          <SelectItem value="ssh">{t('device.typeSSH')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function DeviceBasicFields({
  mode,
  values,
  onChange,
}: Omit<DeviceFieldsProps, 'attempted'>) {
  const { t } = useTranslation();
  const nameInputId = deviceFieldId(mode, 'name');
  const sessionInputId = deviceFieldId(mode, 'session');
  const workingDirInputId = deviceFieldId(mode, 'default-working-dir');

  return (
    <section className="space-y-2.5">
      <SectionHeading>{t('device.sectionBasic')}</SectionHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={nameInputId} text={t('device.name')} required />
          <Input
            id={nameInputId}
            data-testid="device-name-input"
            type="text"
            value={values.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={t('device.namePlaceholder')}
            required
          />
        </div>

        <DeviceTypeSelect mode={mode} values={values} onChange={onChange} />

        <div className="space-y-1.5">
          <FieldLabel htmlFor={sessionInputId} text={t('device.session')} />
          <Input
            id={sessionInputId}
            data-testid="device-session-input"
            type="text"
            value={values.session}
            onChange={(e) => onChange({ session: e.target.value })}
            placeholder={t('device.sessionPlaceholder')}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={workingDirInputId} text={t('device.defaultWorkingDir')} />
          <Input
            id={workingDirInputId}
            data-testid="device-default-working-dir-input"
            type="text"
            value={values.defaultWorkingDir}
            onChange={(e) => onChange({ defaultWorkingDir: e.target.value })}
            placeholder={t('device.defaultWorkingDirPlaceholder')}
          />
        </div>
      </div>
    </section>
  );
}
