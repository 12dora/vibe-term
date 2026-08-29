// 设备对话框状态机：表单值、提交尝试标记、创建/更新 mutation 与类型切换带来的认证方式联动。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createDevice as createDeviceApi, updateDevice as updateDeviceApi } from '@tmex/api-client';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type DeviceFormValues,
  applyDeviceType,
  buildCreatePayload,
  buildUpdatePayload,
  createDefaultFormValues,
  validateDeviceForm,
} from './device-form';

export interface UseDeviceDialogModelOptions {
  mode: 'create' | 'edit';
  device?: Device;
  onClose: () => void;
  queryKey: readonly unknown[];
}

export interface DeviceDialogModel {
  formData: DeviceFormValues;
  attempted: boolean;
  isSubmitting: boolean;
  isEditMode: boolean;
  isSSH: boolean;
  setField: <K extends keyof DeviceFormValues>(key: K, value: DeviceFormValues[K]) => void;
  changeType: (nextType: DeviceFormValues['type']) => void;
  handleSubmit: (event: FormEvent) => void;
}

export function useDeviceDialogModel({
  mode,
  device,
  onClose,
  queryKey,
}: UseDeviceDialogModelOptions): DeviceDialogModel {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<DeviceFormValues>(createDefaultFormValues(device));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const onMutationSuccess = (): void => {
    queryClient.invalidateQueries({ queryKey });
    toast.success(t('common.success'));
    onClose();
  };

  const onMutationError = (err: unknown): void => {
    toast.error(err instanceof Error ? err.message : t('common.error'));
  };

  const createDevice = useMutation({
    mutationFn: (payload: CreateDeviceRequest) =>
      createDeviceApi(payload, t('device.createFailed'), runtime.apiClient),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  });

  const updateDevice = useMutation({
    mutationFn: async (payload: UpdateDeviceRequest) => {
      if (!device) {
        throw new Error(t('apiError.deviceNotFound'));
      }

      return updateDeviceApi(device.id, payload, t('device.updateFailed'), runtime.apiClient);
    },
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  });

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setAttempted(true);

    const validationError = validateDeviceForm(formData);
    if (validationError) {
      toast.error(t(validationError));
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === 'create') {
        await createDevice.mutateAsync(buildCreatePayload(formData));
      } else {
        await updateDevice.mutateAsync(buildUpdatePayload(formData));
      }
    } catch {
      // handled by mutation onError
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    formData,
    attempted,
    isSubmitting,
    isEditMode: mode === 'edit',
    isSSH: formData.type === 'ssh',
    setField: (key, value) => setFormData((d) => ({ ...d, [key]: value })),
    changeType: (nextType) => setFormData((d) => applyDeviceType(d, nextType)),
    handleSubmit,
  };
}
