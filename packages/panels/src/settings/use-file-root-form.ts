import type { Device, FileRootDto } from '@tmex/shared';
import { useEffect, useState } from 'react';

import type { ApiClient } from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';

import {
  type FileRootDeviceGroup,
  type FileRootDeviceOption,
  resolveFileRootClient,
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

/** 编辑模式沿用 root 自己的设备；单设备模式（locked）新增时设备由宿主锁定。 */
export function resolveFileRootFormDeviceId(
  root: FileRootDto | undefined,
  lockedDeviceId: string | undefined
): string {
  return root?.deviceId ?? lockedDeviceId ?? '';
}

/** 启用态不在表单里编辑：新增默认启用，编辑沿用当前值（列表行的开关负责改）。 */
export function resolveFileRootFormEnabled(root: FileRootDto | undefined): boolean {
  return root?.enabled ?? true;
}

export interface FileRootFormParams {
  open: boolean;
  /** 缺省表示新增模式 */
  root?: FileRootDto;
  editClient?: ApiClient;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
  /** 单设备模式：设备只读且新增只落该设备 */
  lockedDeviceId?: string;
  onOpenChange: (open: boolean) => void;
  onRootsMutated?: () => void;
}

export interface FileRootFormModel {
  isEdit: boolean;
  /** 单设备模式：设备字段只读 */
  locked: boolean;
  deviceId: string;
  setDeviceId: (deviceId: string) => void;
  path: string;
  setPath: (path: string) => void;
  enabled: boolean;
  deviceOptions: FileRootDeviceOption[];
  selectedDevice: FileRootDeviceOption | undefined;
  canSubmit: boolean;
  isPending: boolean;
  submit: () => void;
  /** 目录选择器要打的 gateway：与该设备 roots 的落盘 client 一致 */
  browseClient: ApiClient;
}

export function useFileRootForm({
  open,
  root,
  editClient,
  devices,
  deviceGroups,
  lockedDeviceId,
  onOpenChange,
  onRootsMutated,
}: FileRootFormParams): FileRootFormModel {
  const isEdit = Boolean(root);
  const { apiClient } = useRuntime();
  const [deviceId, setDeviceId] = useState(() => resolveFileRootFormDeviceId(root, lockedDeviceId));
  const [path, setPath] = useState('');
  const [enabled, setEnabled] = useState(() => resolveFileRootFormEnabled(root));

  useEffect(() => {
    if (!open) {
      return;
    }
    setDeviceId(resolveFileRootFormDeviceId(root, lockedDeviceId));
    setPath(root?.path ?? '');
    setEnabled(resolveFileRootFormEnabled(root));
  }, [open, root, lockedDeviceId]);

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
    locked: !isEdit && Boolean(lockedDeviceId),
    deviceId,
    setDeviceId,
    path,
    setPath,
    enabled,
    deviceOptions,
    selectedDevice: deviceOptions.find((device) => device.id === deviceId),
    canSubmit,
    isPending: saveMutation.isPending,
    browseClient: isEdit
      ? (editClient ?? apiClient)
      : resolveFileRootClient(deviceGroups, apiClient, deviceId),
    submit: () => {
      if (!canSubmit || saveMutation.isPending) {
        return;
      }
      saveMutation.mutate({ ...draft, path: path.trim() });
    },
  };
}
