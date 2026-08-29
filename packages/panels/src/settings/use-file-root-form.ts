import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ApiClient, FileApiError, createFileRoot, updateFileRoot } from '@tmex/api-client';
import type {
  CreateFileRootRequest,
  Device,
  FileRootDto,
  UpdateFileRootRequest,
} from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  type FileRootDeviceGroup,
  type FileRootDeviceOption,
  canSubmitFileRootForm,
  deriveFileRootDeviceOptions,
  resolveFileRootClient,
} from './file-root-form-model';

export interface UseFileRootFormInput {
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

export interface FileRootForm {
  isEdit: boolean;
  deviceId: string;
  setDeviceId: (deviceId: string) => void;
  path: string;
  setPath: (path: string) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  deviceOptions: FileRootDeviceOption[];
  selectedDevice?: FileRootDeviceOption;
  isPending: boolean;
  canSubmit: boolean;
  submit: () => void;
}

export function useFileRootForm({
  open,
  onOpenChange,
  root,
  editClient,
  devices,
  deviceGroups,
  onRootsMutated,
}: UseFileRootFormInput): FileRootForm {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();
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

  const onMutationSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ['files'] });
    onRootsMutated?.();
    toast.success(t('common.success'));
    onOpenChange(false);
  };

  const createMutation = useMutation({
    mutationFn: () => {
      const payload: CreateFileRootRequest = { deviceId, path: path.trim(), enabled };
      const client = resolveFileRootClient({
        isEdit: false,
        deviceId,
        fallbackClient: apiClient,
        deviceGroups,
      });
      return createFileRoot(payload, client);
    },
    onSuccess: onMutationSuccess,
    onError: (err) => {
      const message = err instanceof FileApiError ? err.message : t('settings.files.addFailed');
      toast.error(message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!root) {
        throw new Error(t('settings.files.updateFailed'));
      }
      const payload: UpdateFileRootRequest = { path: path.trim(), enabled };
      const client = resolveFileRootClient({
        isEdit: true,
        deviceId,
        editClient,
        fallbackClient: apiClient,
        deviceGroups,
      });
      return updateFileRoot(root.id, payload, client);
    },
    onSuccess: onMutationSuccess,
    onError: (err) => {
      const message = err instanceof FileApiError ? err.message : t('settings.files.updateFailed');
      toast.error(message);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const canSubmit = canSubmitFileRootForm({ isEdit, deviceId, path });
  const deviceOptions = deriveFileRootDeviceOptions(devices, deviceGroups);

  const submit = () => {
    if (!canSubmit || isPending) {
      return;
    }
    if (isEdit) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

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
    isPending,
    canSubmit,
    submit,
  };
}
