// SSH 认证字段：认证方式选择 + 四种模式各自的输入项（agent 无额外输入）。

import type { CreateDeviceRequest } from '@tmex/shared';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Textarea } from '@tmex/ui/textarea';
import { useTranslation } from 'react-i18next';
import {
  type DeviceFieldsProps,
  FieldLabel,
  SectionHeading,
  deviceFieldId,
} from './device-field-primitives';

function AuthModeSelect({ mode, values, onChange }: Omit<DeviceFieldsProps, 'attempted'>) {
  const { t } = useTranslation();
  const selectId = deviceFieldId(mode, 'auth-mode');
  const authLabels: Record<string, string> = {
    password: t('device.authPassword'),
    key: t('device.authKey'),
    agent: t('device.authAgent'),
    configRef: t('device.authConfigRef'),
  };

  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={selectId} text={t('device.authMode')} />
      <Select
        value={values.authMode}
        onValueChange={(nextValue) => {
          if (!nextValue) return;
          onChange({ authMode: nextValue as CreateDeviceRequest['authMode'] });
        }}
      >
        <SelectTrigger id={selectId} data-testid="device-auth-mode-select" className="w-full">
          <SelectValue placeholder={t('device.authMode')}>
            {(value) => authLabels[value as string] ?? ''}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="password">{t('device.authPassword')}</SelectItem>
          <SelectItem value="key">{t('device.authKey')}</SelectItem>
          <SelectItem value="agent">{t('device.authAgent')}</SelectItem>
          <SelectItem value="configRef">{t('device.authConfigRef')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function PasswordAuthFields({ mode, values, onChange }: Omit<DeviceFieldsProps, 'attempted'>) {
  const { t } = useTranslation();
  const passwordInputId = deviceFieldId(mode, 'password');

  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={passwordInputId} text={t('device.password')} />
      <Input
        id={passwordInputId}
        type="password"
        value={values.password}
        onChange={(e) => onChange({ password: e.target.value })}
      />
    </div>
  );
}

function KeyAuthFields({ mode, values, onChange }: Omit<DeviceFieldsProps, 'attempted'>) {
  const { t } = useTranslation();
  const privateKeyId = deviceFieldId(mode, 'private-key');
  const passphraseId = deviceFieldId(mode, 'private-key-passphrase');

  return (
    <>
      <div className="space-y-1.5">
        <FieldLabel htmlFor={privateKeyId} text={t('device.privateKey')} />
        <Textarea
          id={privateKeyId}
          value={values.privateKey}
          onChange={(e) => onChange({ privateKey: e.target.value })}
          className="h-28 font-mono text-xs"
          placeholder={t('device.privateKeyPlaceholder')}
        />
      </div>
      <div className="space-y-1.5">
        <FieldLabel htmlFor={passphraseId} text={t('device.passphrase')} />
        <Input
          id={passphraseId}
          type="password"
          value={values.privateKeyPassphrase}
          onChange={(e) => onChange({ privateKeyPassphrase: e.target.value })}
        />
      </div>
    </>
  );
}

function ConfigRefAuthFields({ mode, values, attempted, onChange }: DeviceFieldsProps) {
  const { t } = useTranslation();
  const configRefId = deviceFieldId(mode, 'ssh-config-ref');

  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={configRefId} text={t('device.authConfigRef')} required />
      <Input
        id={configRefId}
        data-testid="device-ssh-config-ref-input"
        type="text"
        value={values.sshConfigRef}
        onChange={(e) => onChange({ sshConfigRef: e.target.value })}
        placeholder={t('device.sshConfigRefPlaceholder')}
        aria-invalid={attempted && !values.sshConfigRef.trim()}
      />
      <p className="text-[11px] text-muted-foreground">{t('device.sshConfigRefHint')}</p>
    </div>
  );
}

function AuthModeExtraFields(props: DeviceFieldsProps) {
  switch (props.values.authMode) {
    case 'password':
      return <PasswordAuthFields {...props} />;
    case 'key':
      return <KeyAuthFields {...props} />;
    case 'configRef':
      return <ConfigRefAuthFields {...props} />;
    default:
      return null;
  }
}

export function DeviceAuthFields(props: DeviceFieldsProps) {
  const { t } = useTranslation();

  return (
    <section className="space-y-2.5">
      <SectionHeading>{t('device.sectionAuth')}</SectionHeading>
      <div className="space-y-3">
        <AuthModeSelect {...props} />
        <AuthModeExtraFields {...props} />
      </div>
    </section>
  );
}
