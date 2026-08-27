import type { Device, FileRootDto } from '@tmex/shared';
import { useEffect, useState } from 'react';

import type { ApiClient } from '@tmex/api-client';

import {
  type FileRootDeviceGroup,
  type FileRootDeviceOption,
  useFileRootSaveMutation,
} from './file-root-query';

export function collectFileRootDeviceOptions(
  deviceGroups: FileRootDeviceGroup[] | undefined,
  devices: Device[]
): FileRootDeviceOption[] {
  return deviceGroups ? deviceGroups.flatMap((group) => group.devices) : devices;
}

export interface FileRootFormDraft {
  deviceId: string;
  path: string;
  enabled: boolean;
}

/** 路径必须是绝对路径；新增模式还必须选中设备（编辑模式设备不可改）。 */
export function isFileRootFormSubmittable(draft: FileRootFormDraft, isEdit: boolean): boolean {
  const pathValid = draft.path.trim().startsWith('/');
  return pathValid && (isEdit || draft.deviceId.length > 0);
}

export interface FileRootFormParams {
  open: boolean;
  /** 缺省表示新增模式 */
  root?: FileRootDto;
  editClient?: ApiClient;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
  onOpenChange: (open: boolean) => void;
  onRootsMutated?: () => void;
}

export interface FileRootFormModel {
  isEdit: boolean;
  deviceId: string;
  setDeviceId: (deviceId: string) => void;
  path: string;
  setPath: (path: string) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  deviceOptions: FileRootDeviceOption[];
  selectedDevice: FileRootDeviceOption | undefined;
  canSubmit: boolean;
  isPending: boolean;
  submit: () => void;
}

export function useFileRootForm({
  open,
  root,
  editClient,
  devices,
  deviceGroups,
  onOpenChange,
  onRootsMutated,
}: FileRootFormParams): FileRootFormModel {
  const isEdit = Boolean(root);
  const [deviceId, setDeviceId] = useState('');
  const [path, setPath] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDeviceId(root?.deviceId ?? '');
    setPath(root?.path ?? '');
    setEnabled(root?.enabled ?? true);
  }, [open, root]);

  const saveMutation = useFileRootSaveMutation({
    root,
    editClient,
    deviceGroups,
    handlers: { onRootsMutated, onDone: () => onOpenChange(false) },
  });

  const draft: FileRootFormDraft = { deviceId, path, enabled };
  const canSubmit = isFileRootFormSubmittable(draft, isEdit);
  const deviceOptions = collectFileRootDeviceOptions(deviceGroups, devices);

  return {
    isEdit,
    deviceId,
    setDeviceId,
    path,
    setPath,
    enabled,
    setEnabled,
    deviceOptions,
    selectedDevice: deviceOptions.find((device) => device.id === deviceId),
    canSubmit,
    isPending: saveMutation.isPending,
    submit: () => {
      if (!canSubmit || saveMutation.isPending) {
        return;
      }
      saveMutation.mutate({ ...draft, path: path.trim() });
    },
  };
}
