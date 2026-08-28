// SSH 连接字段：主机、端口、用户名。

import { Input } from '@tmex/ui/input';
import { useTranslation } from 'react-i18next';
import {
  type DeviceFieldsProps,
  FieldLabel,
  SectionHeading,
  deviceFieldId,
} from './device-field-primitives';
import { isValidSshPort } from './device-form';

function SshPortField({ mode, values, attempted, onChange }: DeviceFieldsProps) {
  const { t } = useTranslation();
  const portInputId = deviceFieldId(mode, 'port');

  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={portInputId} text={t('device.port')} required />
      <Input
        id={portInputId}
        type="number"
        value={Number.isNaN(values.port) ? '' : values.port}
        onChange={(e) => {
          const raw = e.target.value;
          onChange({ port: raw === '' ? Number.NaN : Number.parseInt(raw, 10) });
        }}
        min={1}
        max={65535}
        aria-invalid={attempted && !isValidSshPort(values.port)}
      />
    </div>
  );
}

export function DeviceSshConnectionFields(props: DeviceFieldsProps) {
  const { mode, values, attempted, onChange } = props;
  const { t } = useTranslation();
  const hostInputId = deviceFieldId(mode, 'host');
  const usernameInputId = deviceFieldId(mode, 'username');

  return (
    <section className="space-y-2.5">
      <SectionHeading>{t('device.sectionConnection')}</SectionHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={hostInputId} text={t('device.host')} required />
          <Input
            id={hostInputId}
            type="text"
            value={values.host}
            onChange={(e) => onChange({ host: e.target.value })}
            placeholder={t('device.hostPlaceholder')}
            aria-invalid={attempted && !values.host.trim()}
          />
        </div>

        <SshPortField {...props} />

        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={usernameInputId} text={t('device.username')} required />
          <Input
            id={usernameInputId}
            type="text"
            value={values.username}
            onChange={(e) => onChange({ username: e.target.value })}
            placeholder={t('device.usernamePlaceholder')}
            aria-invalid={attempted && !values.username.trim()}
          />
        </div>
      </div>
    </section>
  );
}
