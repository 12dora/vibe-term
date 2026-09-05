// 分享弹窗数据面：草稿、地址候选、创建/终止两个变更，以及「创建态 / 进行中态」的选择。

import { useMutation, useQuery } from '@tanstack/react-query';
import { createShare, getShareOrigins, revokeShare } from '@tmex/api-client';
import { shareErrorKey } from '@tmex/api-client/share-errors';
import {
  type ShareOriginCandidate,
  type ShareRecord,
  generateSharePassword,
} from '@tmex/shared/share';
import { useRuntime } from '@tmex/stores/react';
import { toast } from '@tmex/ui/toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SetShareDraftField } from './share-create-form';
import {
  type ShareDraft,
  buildCreateShareInput,
  createShareDraft,
  pickDefaultShareOrigin,
  resolveActiveShare,
  validateShareDraft,
} from './share-dialog-model';
import { useShareStatus } from './use-share-status';

export const shareOriginsQueryKey = ['share-origins'] as const;

export interface ShareDialogInput {
  open: boolean;
  deviceId: string;
  windowId: string;
  defaultName: string;
}

export interface ShareDialogModel {
  draft: ShareDraft;
  setField: SetShareDraftField;
  regeneratePassword: () => void;
  candidates: readonly ShareOriginCandidate[];
  activeShare: ShareRecord | null;
  /** 仅刚创建的那一次拿得到明文密码。 */
  createdPassword: string | null;
  loading: boolean;
  creating: boolean;
  stopping: boolean;
  submit: () => void;
  stop: () => void;
}

interface CreatedShare {
  share: ShareRecord;
  password: string;
  /** 创建时刻：列表查询晚于它落地后，进行中态一律以列表为准。 */
  at: number;
}

export function useShareDialog({
  open,
  deviceId,
  windowId,
  defaultName,
}: ShareDialogInput): ShareDialogModel {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const status = useShareStatus(deviceId, windowId, open);

  const originsQuery = useQuery({
    queryKey: shareOriginsQueryKey,
    queryFn: () => getShareOrigins(apiClient),
    enabled: open,
    throwOnError: false,
  });
  const origins = originsQuery.data;

  const [draft, setDraft] = useState<ShareDraft>(() =>
    createShareDraft({ name: defaultName, password: generateSharePassword() })
  );
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [revokedId, setRevokedId] = useState<string | null>(null);

  // 打开时重置草稿：默认名随 tab 改名而变，但不该在编辑途中把输入框冲掉，故从 ref 取值
  const defaultNameRef = useRef(defaultName);
  defaultNameRef.current = defaultName;
  useEffect(() => {
    if (!open) return;
    setDraft(createShareDraft({ name: defaultNameRef.current, password: generateSharePassword() }));
    setCreated(null);
    setRevokedId(null);
  }, [open]);

  // 也依赖 open：弹窗关了不卸载，重开时草稿被重置成空地址，而 react-query 对同一份响应
  // 保持引用不变，只认 origins 的 effect 不会再跑一次，创建就卡在「请选择地址」。
  useEffect(() => {
    if (!open || !origins?.candidates.length) return;
    setDraft((prev) =>
      prev.origin
        ? prev
        : { ...prev, origin: pickDefaultShareOrigin(origins.candidates, origins.recommended) }
    );
  }, [open, origins]);

  const setField = useCallback<SetShareDraftField>((key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const regeneratePassword = useCallback(() => {
    setDraft((prev) => ({ ...prev, password: generateSharePassword() }));
  }, []);

  const createMutation = useMutation({
    mutationFn: async () => {
      const input = buildCreateShareInput(draft, deviceId, windowId);
      if (!input) throw new Error(t('share.error.invalidDuration'));
      return createShare(apiClient, input);
    },
    onSuccess: (result) => {
      setCreated({ share: result.share, password: result.password, at: Date.now() });
      setRevokedId(null);
      toast.success(t('share.dialog.created'));
      status.refresh();
    },
    onError: (error) => toast.error(t(shareErrorKey(error))),
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => revokeShare(apiClient, id),
    onSuccess: (share) => {
      setRevokedId(share.id);
      setCreated(null);
      toast.success(t('share.dialog.stopped'));
      status.refresh();
    },
    onError: (error) => toast.error(t(shareErrorKey(error))),
  });

  const activeShare = resolveActiveShare({
    fromQuery: status.activeShare,
    created,
    dataUpdatedAt: status.dataUpdatedAt,
    revokedId,
  });

  const submit = useCallback(() => {
    const error = validateShareDraft(draft);
    if (error) {
      toast.error(t(error.key, error.params));
      return;
    }
    createMutation.mutate();
  }, [createMutation, draft, t]);

  const stop = useCallback(() => {
    if (activeShare) stopMutation.mutate(activeShare.id);
  }, [activeShare, stopMutation]);

  return {
    draft,
    setField,
    regeneratePassword,
    candidates: origins?.candidates ?? [],
    activeShare,
    createdPassword:
      created && activeShare && created.share.id === activeShare.id ? created.password : null,
    loading: status.isLoading || originsQuery.isLoading,
    creating: createMutation.isPending,
    stopping: stopMutation.isPending,
    submit,
    stop,
  };
}
