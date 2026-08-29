// 设备对话框的字段分组：基础信息、SSH 连接参数、SSH 认证方式（四种分支）。

import type { CreateDeviceRequest } from '@tmex/shared';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Textarea } from '@tmex/ui/textarea';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidSshPort, parseSshPortInput } from './device-form';
import type { DeviceDialogModel } from './use-device-dialog-model';

export interface DeviceFieldIds {
  name: string;
  type: string;
  host: string;
  port: string;
  username: string;
  session: string;
  defaultWorkingDir: string;
  authMode: string;
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
  sshConfigRef: string;
}

export function createDeviceFieldIds(mode: 'create' | 'edit'): DeviceFieldIds {
  return {
    name: `${mode}-device-name`,
    type: `${mode}-device-type`,
    host: `${mode}-device-host`,
    port: `${mode}-device-port`,
    username: `${mode}-device-username`,
    session: `${mode}-device-session`,
    defaultWorkingDir: `${mode}-device-default-working-dir`,
    authMode: `${mode}-device-auth-mode`,
    password: `${mode}-device-password`,
    privateKey: `${mode}-device-private-key`,
    privateKeyPassphrase: `${mode}-device-private-key-passphrase`,
    sshConfigRef: `${mode}-device-ssh-config-ref`,
  };
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

interface FieldLabelProps {
  htmlFor: string;
  text: string;
  required?: boolean;
}

export function FieldLabel({ htmlFor, text, required }: FieldLabelProps) {
  return (
    <label className="block text-xs font-medium text-foreground" htmlFor={htmlFor}>
      {text}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  );
}

interface DeviceFieldsProps {
  ids: DeviceFieldIds;
  model: DeviceDialogModel;
}

export function DeviceBasicFields({ ids, model }: DeviceFieldsProps) {
  const { t } = useTranslation();
  const { formData, setField } = model;
  const typeLabels: Record<string, string> = {
    local: t('device.typeLocal'),
    ssh: t('device.typeSSH'),
  };

  return (
    <section className="space-y-2.5">
      <SectionHeading>{t('device.sectionBasic')}</SectionHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={ids.name} text={t('device.name')} required />
          <Input
            id={ids.name}
            data-testid="device-name-input"
            type="text"
            value={formData.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder={t('device.namePlaceholder')}
            required
          />
        </div>

        <div className="space-y-1.5">
          <FieldLabel htmlFor={ids.type} text={t('device.type')} />
          <Select
            value={formData.type}
            onValueChange={(nextValue) => {
              if (!nextValue) return;
              model.changeType(nextValue as 'local' | 'ssh');
            }}
            disabled={model.isEditMode}
          >
            <SelectTrigger id={ids.type} data-testid="device-type-select" className="w-full">
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

        <div className="space-y-1.5">
          <FieldLabel htmlFor={ids.session} text={t('device.session')} />
          <Input
            id={ids.session}
            data-testid="device-session-input"
            type="text"
            value={formData.session}
            onChange={(e) => setField('session', e.target.value)}
            placeholder={t('device.sessionPlaceholder')}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={ids.defaultWorkingDir} text={t('device.defaultWorkingDir')} />
          <Input
            id={ids.defaultWorkingDir}
            data-testid="device-default-working-dir-input"
            type="text"
            value={formData.defaultWorkingDir}
            onChange={(e) => setField('defaultWorkingDir', e.target.value)}
            placeholder={t('device.defaultWorkingDirPlaceholder')}
          />
        </div>
      </div>
    </section>
  );
}

export function DeviceSshConnectionFields({ ids, model }: DeviceFieldsProps) {
  const { t } = useTranslation();
  const { formData, attempted, setField } = model;

  return (
    <section className="space-y-2.5">
      <SectionHeading>{t('device.sectionConnection')}</SectionHeading>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={ids.host} text={t('device.host')} required />
          <Input
            id={ids.host}
            type="text"
            value={formData.host}
            onChange={(e) => setField('host', e.target.value)}
            placeholder={t('device.hostPlaceholder')}
            aria-invalid={attempted && !formData.host.trim()}
          />
        </div>

        <div className="space-y-1.5">
          <FieldLabel htmlFor={ids.port} text={t('device.port')} required />
          <Input
            id={ids.port}
            type="number"
            value={Number.isNaN(formData.port) ? '' : formData.port}
            onChange={(e) => setField('port', parseSshPortInput(e.target.value))}
            min={1}
            max={65535}
            aria-invalid={attempted && !isValidSshPort(formData.port)}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel htmlFor={ids.username} text={t('device.username')} required />
          <Input
            id={ids.username}
            type="text"
            value={formData.username}
            onChange={(e) => setField('username', e.target.value)}
            placeholder={t('device.usernamePlaceholder')}
            aria-invalid={attempted && !formData.username.trim()}
          />
        </div>
      </div>
    </section>
  );
}

export function DeviceAuthFields({ ids, model }: DeviceFieldsProps) {
  const { t } = useTranslation();
  const { formData, attempted, setField } = model;
  const authLabels: Record<string, string> = {
    password: t('device.authPassword'),
    key: t('device.authKey'),
    agent: t('device.authAgent'),
    configRef: t('device.authConfigRef'),
  };

  return (
    <section className="space-y-2.5">
      <SectionHeading>{t('device.sectionAuth')}</SectionHeading>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <FieldLabel htmlFor={ids.authMode} text={t('device.authMode')} />
          <Select
            value={formData.authMode}
            onValueChange={(nextValue) => {
              if (!nextValue) return;
              setField('authMode', nextValue as CreateDeviceRequest['authMode']);
            }}
          >
            <SelectTrigger
              id={ids.authMode}
              data-testid="device-auth-mode-select"
              className="w-full"
            >
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

        {formData.authMode === 'password' && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={ids.password} text={t('device.password')} />
            <Input
              id={ids.password}
              type="password"
              value={formData.password}
              onChange={(e) => setField('password', e.target.value)}
            />
          </div>
        )}

        {formData.authMode === 'key' && (
          <>
            <div className="space-y-1.5">
              <FieldLabel htmlFor={ids.privateKey} text={t('device.privateKey')} />
              <Textarea
                id={ids.privateKey}
                value={formData.privateKey}
                onChange={(e) => setField('privateKey', e.target.value)}
                className="h-28 font-mono text-xs"
                placeholder={t('device.privateKeyPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor={ids.privateKeyPassphrase} text={t('device.passphrase')} />
              <Input
                id={ids.privateKeyPassphrase}
                type="password"
                value={formData.privateKeyPassphrase}
                onChange={(e) => setField('privateKeyPassphrase', e.target.value)}
              />
            </div>
          </>
        )}

        {formData.authMode === 'configRef' && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={ids.sshConfigRef} text={t('device.authConfigRef')} required />
            <Input
              id={ids.sshConfigRef}
              data-testid="device-ssh-config-ref-input"
              type="text"
              value={formData.sshConfigRef}
              onChange={(e) => setField('sshConfigRef', e.target.value)}
              placeholder={t('device.sshConfigRefPlaceholder')}
              aria-invalid={attempted && !formData.sshConfigRef.trim()}
            />
            <p className="text-[11px] text-muted-foreground">{t('device.sshConfigRefHint')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
