import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAgentLlmSettings, parseApiError } from '@vibeterm/api-client';
import type { LlmProviderDto, UpdateAgentLlmSettingsRequest } from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { SETTINGS_STALE_MS } from './settings-query';

export interface LlmDefaultsDraft {
  providerId: string | null;
  modelId: string;
}

/** 显式换提供商：当前模型不属于新提供商时一并清空，避免留下悬空模型 */
export function applyDefaultProvider(
  draft: LlmDefaultsDraft,
  providers: LlmProviderDto[],
  nextProviderId: string | null
): LlmDefaultsDraft {
  const next = providers.find((provider) => provider.id === nextProviderId);
  return {
    providerId: nextProviderId,
    modelId: next?.models.includes(draft.modelId) ? draft.modelId : '',
  };
}

/** 选模型：provider 跟着模型走；清空项两者同时清空 */
export function applyDefaultModel(selection: {
  providerId: string | null;
  modelId: string | null;
}): LlmDefaultsDraft {
  return { providerId: selection.providerId, modelId: selection.modelId ?? '' };
}

export function buildDefaultsPayload(draft: LlmDefaultsDraft): UpdateAgentLlmSettingsRequest {
  return {
    defaultProviderId: draft.providerId,
    defaultModelId: draft.modelId.trim() || null,
  };
}

export interface LlmDefaultsState {
  draft: LlmDefaultsDraft;
  selectProvider: (providerId: string | null) => void;
  selectModel: (selection: { providerId: string | null; modelId: string | null }) => void;
  save: () => void;
  isLoading: boolean;
  isSaving: boolean;
}

/** 全局默认（provider + model）的本地草稿：拉取回填、两个字段互相同步、保存 */
export function useLlmDefaultsState(providers: LlmProviderDto[]): LlmDefaultsState {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();

  const [draft, setDraft] = useState<LlmDefaultsDraft>({ providerId: null, modelId: '' });

  const settingsQuery = useQuery({
    queryKey: ['llm-settings'],
    queryFn: () => fetchAgentLlmSettings(t('settings.llm.settingsLoadFailed'), apiClient),
    staleTime: SETTINGS_STALE_MS,
  });

  const serverProviderId = settingsQuery.data?.settings.defaultProviderId ?? null;
  const serverModelId = settingsQuery.data?.settings.defaultModelId ?? '';
  const settingsLoaded = Boolean(settingsQuery.data);

  useEffect(() => {
    if (!settingsLoaded) return;
    setDraft({ providerId: serverProviderId, modelId: serverModelId });
  }, [settingsLoaded, serverProviderId, serverModelId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.fetch('/api/llm/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildDefaultsPayload(draft)),
      });
      if (!res.ok) throw new Error(await parseApiError(res, t('settings.llm.settingsSaveFailed')));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return {
    draft,
    selectProvider: (providerId) =>
      setDraft((current) => applyDefaultProvider(current, providers, providerId)),
    selectModel: (selection) => setDraft(applyDefaultModel(selection)),
    save: () => saveMutation.mutate(),
    isLoading: settingsQuery.isLoading,
    isSaving: saveMutation.isPending,
  };
}
