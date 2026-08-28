import type { Device, FileRootDto } from '@tmex/shared';
import { useTranslation } from 'react-i18next';

import { Input } from '@tmex/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@tmex/ui/select';
import { Switch } from '@tmex/ui/switch';

import { FileRootDeviceIcon } from './file-root-device-icon';
import type { FileRootDeviceGroup, FileRootDeviceOption } from './file-root-query';
import type { FileRootFormModel } from './use-file-root-form';

const FIELD_CLASS = 'h-9 w-full';

function renderDeviceItem(device: FileRootDeviceOption) {
  return (
    <SelectItem key={device.id} value={device.id}>
      <FileRootDeviceIcon type={device.type ?? null} className="h-4 w-4 shrink-0" />
      {device.name}
    </SelectItem>
  );
}

function DeviceSelectValue({ selected }: { selected: FileRootDeviceOption | undefined }) {
  const { t } = useTranslation();
  if (!selected) {
    return <span className="text-muted-foreground">{t('settings.files.devicePlaceholder')}</span>;
  }
  return (
    <span className="flex items-center gap-1.5">
      <FileRootDeviceIcon type={selected.type ?? null} className="h-4 w-4 shrink-0" />
      {selected.name}
    </span>
  );
}

function DeviceReadonlyValue({ root }: { root: FileRootDto | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-9 items-center gap-1.5 rounded-lg border border-input bg-muted/30 px-2.5 text-sm">
      <FileRootDeviceIcon type={root?.deviceType ?? null} className="h-4 w-4 shrink-0" />
      <span className="truncate">{root?.deviceName ?? t('settings.files.missing')}</span>
    </div>
  );
}

interface DeviceSelectProps {
  form: FileRootFormModel;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
}

function DeviceSelect({ form, devices, deviceGroups }: DeviceSelectProps) {
  return (
    <Select
      value={form.deviceId}
      onValueChange={(value) => {
        if (!value) return;
        form.setDeviceId(value);
      }}
    >
      <SelectTrigger
        id="files-form-device"
        data-testid="settings-files-device-select"
        className={FIELD_CLASS}
        disabled={form.deviceOptions.length === 0}
      >
        <SelectValue>
          <DeviceSelectValue selected={form.selectedDevice} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {deviceGroups
          ? deviceGroups.map((group, index) => (
              <SelectGroup key={`${group.label}-${index}`}>
                {group.label ? <SelectLabel>{group.label}</SelectLabel> : null}
                {group.devices.map(renderDeviceItem)}
              </SelectGroup>
            ))
          : devices.map(renderDeviceItem)}
      </SelectContent>
    </Select>
  );
}

export interface FileRootDeviceFieldProps extends DeviceSelectProps {
  root?: FileRootDto;
}

export function FileRootDeviceField({
  form,
  root,
  devices,
  deviceGroups,
}: FileRootDeviceFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium" htmlFor="files-form-device">
        {t('settings.files.device')}
      </label>
      {form.isEdit ? (
        <DeviceReadonlyValue root={root} />
      ) : (
        <DeviceSelect form={form} devices={devices} deviceGroups={deviceGroups} />
      )}
      {!form.isEdit && form.deviceOptions.length === 0 && (
        <p className="text-xs text-destructive">{t('settings.files.noDevices')}</p>
      )}
    </div>
  );
}

export function FileRootPathField({ form }: { form: FileRootFormModel }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium" htmlFor="files-form-path">
        {t('settings.files.path')}
      </label>
      <Input
        id="files-form-path"
        data-testid="settings-files-path-input"
        value={form.path}
        onChange={(event) => form.setPath(event.target.value)}
        placeholder={t('settings.files.pathPlaceholder')}
        className={`${FIELD_CLASS} font-mono`}
      />
      <p className="text-xs text-muted-foreground">{t('settings.files.pathHint')}</p>
    </div>
  );
}

export function FileRootEnabledField({ form }: { form: FileRootFormModel }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={form.enabled}
        onCheckedChange={(checked) => form.setEnabled(Boolean(checked))}
        data-testid="settings-files-enabled-switch"
      />
      <label className="text-sm font-medium" htmlFor="settings-files-enabled-switch">
        {t('settings.files.enabled')}
      </label>
    </div>
  );
}
