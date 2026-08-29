import type { ApiClient } from '@tmex/api-client';
import type { Device, DeviceType, FileRootDto } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
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
import { Globe, Loader2, Monitor, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileRootDeviceGroup, FileRootDeviceOption } from './file-root-form-model';
import { type FileRootForm, useFileRootForm } from './use-file-root-form';

const FIELD_CLASS = 'h-9 w-full';

export function DeviceIcon({
  type,
  className,
}: {
  type: DeviceType | null;
  className?: string;
}) {
  if (type === 'ssh') {
    return <Globe className={className} />;
  }
  return <Monitor className={className} />;
}

function renderDeviceItem(device: FileRootDeviceOption) {
  return (
    <SelectItem key={device.id} value={device.id}>
      <DeviceIcon type={device.type ?? null} className="h-4 w-4 shrink-0" />
      {device.name}
    </SelectItem>
  );
}

interface FileRootDeviceSelectProps {
  form: FileRootForm;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
}

function FileRootDeviceSelect({ form, devices, deviceGroups }: FileRootDeviceSelectProps) {
  const { t } = useTranslation();
  const { selectedDevice } = form;

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
          {selectedDevice ? (
            <span className="flex items-center gap-1.5">
              <DeviceIcon type={selectedDevice.type ?? null} className="h-4 w-4 shrink-0" />
              {selectedDevice.name}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('settings.files.devicePlaceholder')}</span>
          )}
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

interface FileRootDeviceFieldProps extends FileRootDeviceSelectProps {
  root?: FileRootDto;
}

function FileRootDeviceField({ form, devices, deviceGroups, root }: FileRootDeviceFieldProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium" htmlFor="files-form-device">
        {t('settings.files.device')}
      </label>
      {form.isEdit ? (
        <div className="flex h-9 items-center gap-1.5 rounded-lg border border-input bg-muted/30 px-2.5 text-sm">
          <DeviceIcon type={root?.deviceType ?? null} className="h-4 w-4 shrink-0" />
          <span className="truncate">{root?.deviceName ?? t('settings.files.missing')}</span>
        </div>
      ) : (
        <FileRootDeviceSelect form={form} devices={devices} deviceGroups={deviceGroups} />
      )}
      {!form.isEdit && form.deviceOptions.length === 0 && (
        <p className="text-xs text-destructive">{t('settings.files.noDevices')}</p>
      )}
    </div>
  );
}

export interface FileRootFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  root?: FileRootDto;
  /** 编辑模式下该 root 的来源 client；缺省用 runtime 的 apiClient */
  editClient?: ApiClient;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
  onRootsMutated?: () => void;
}

export function FileRootFormModal({
  open,
  onOpenChange,
  root,
  editClient,
  devices,
  deviceGroups,
  onRootsMutated,
}: FileRootFormModalProps) {
  const { t } = useTranslation();
  const form = useFileRootForm({
    open,
    onOpenChange,
    root,
    editClient,
    devices,
    deviceGroups,
    onRootsMutated,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={
          form.isEdit ? `settings-files-edit-modal-${root?.id}` : 'settings-files-add-modal'
        }
      >
        <DialogHeader>
          <DialogTitle>
            {form.isEdit ? t('settings.files.modalEditTitle') : t('settings.files.modalAddTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.files.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FileRootDeviceField
            form={form}
            devices={devices}
            deviceGroups={deviceGroups}
            root={root}
          />

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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            data-testid="settings-files-form-submit"
            onClick={form.submit}
            disabled={!form.canSubmit || form.isPending}
          >
            {form.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
