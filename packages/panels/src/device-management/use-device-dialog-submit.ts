// 设备对话框提交逻辑：payload 构造（纯函数）、create/update mutation 选择与错误提示。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createDevice as createDeviceApi, updateDevice as updateDeviceApi } from '@tmex/api-client';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type DeviceFormValues,
  buildCreatePayload,
  buildUpdatePayload,
  validateDeviceForm,
} from './device-form';

export type DeviceDialogMode = 'create' | 'edit';

export type DeviceMutationPayload =
  | { mode: 'create'; payload: CreateDeviceRequest }
  | { mode: 'edit'; payload: UpdateDeviceRequest };

export function buildDevicePayload(
  values: DeviceFormValues,
  mode: DeviceDialogMode
): DeviceMutationPayload {
  return mode === 'create'
    ? { mode, payload: buildCreatePayload(values) }
    : { mode, payload: buildUpdatePayload(values) };
}

export function resolveMutationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function useMutationCallbacks(queryKey: readonly unknown[], onClose: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(t('common.success'));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(resolveMutationErrorMessage(error, t('common.error')));
    },
  };
}

export interface DeviceDialogSubmitParams {
  mode: DeviceDialogMode;
  device?: Device;
  values: DeviceFormValues;
  queryKey: readonly unknown[];
  onClose: () => void;
}

export interface DeviceDialogSubmitModel {
  attempted: boolean;
  isSubmitting: boolean;
  handleSubmit: (event: FormEvent) => Promise<void>;
}

export function useDeviceDialogSubmit({
  mode,
  device,
  values,
  queryKey,
  onClose,
}: DeviceDialogSubmitParams): DeviceDialogSubmitModel {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const callbacks = useMutationCallbacks(queryKey, onClose);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (payload: CreateDeviceRequest) =>
      createDeviceApi(payload, t('device.createFailed'), runtime.apiClient),
    ...callbacks,
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: UpdateDeviceRequest) => {
      if (!device) {
        throw new Error(t('apiError.deviceNotFound'));
      }
      return updateDeviceApi(device.id, payload, t('device.updateFailed'), runtime.apiClient);
    },
    ...callbacks,
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);

    const validationError = validateDeviceForm(values);
    if (validationError) {
      toast.error(t(validationError));
      return;
    }

    setIsSubmitting(true);
    try {
      const request = buildDevicePayload(values, mode);
      if (request.mode === 'create') {
        await createMutation.mutateAsync(request.payload);
      } else {
        await updateMutation.mutateAsync(request.payload);
      }
    } catch {
      // 失败提示已由 mutation onError 处理
    } finally {
      setIsSubmitting(false);
    }
  };

  return { attempted, isSubmitting, handleSubmit };
}
