import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteWatchRule,
  fetchWatchRuleState,
  fetchWatchRules,
  updateWatchRule,
  watchRuleStateQueryKey,
  watchRulesQueryKey,
} from '@tmex/api-client';
import { errorMessage } from '@tmex/shared';
import type { WatchRuleDto, WatchRuleSampleDto, WatchRuleStateDto } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { toast } from '@tmex/ui/toast';
import { useTranslation } from 'react-i18next';

export type WatchQueryStatus = 'loading' | 'error' | 'ready';

export interface QueryStatusInput {
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
}

/** 失败且无可用数据才算 error：后台 refetch 失败时保留已渲染的数据 */
export function resolveQueryStatus({
  isLoading,
  isError,
  hasData,
}: QueryStatusInput): WatchQueryStatus {
  if (isError && !hasData) {
    return 'error';
  }
  return isLoading ? 'loading' : 'ready';
}

export interface WatchRulesModel {
  rules: WatchRuleDto[];
  status: WatchQueryStatus;
  retry: () => void;
  refresh: () => void;
}

export function useWatchRules(deviceId: string, paneId: string, enabled: boolean): WatchRulesModel {
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: watchRulesQueryKey(deviceId, paneId),
    queryFn: () => fetchWatchRules(deviceId, paneId, apiClient),
    enabled,
    throwOnError: false,
  });

  return {
    rules: query.data ?? [],
    status: resolveQueryStatus({
      isLoading: query.isLoading,
      isError: query.isError,
      hasData: query.data !== undefined,
    }),
    retry: () => {
      void query.refetch();
    },
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: ['watch-rules'] });
    },
  };
}

export interface WatchRuleStateModel {
  state: WatchRuleStateDto | null;
  samples: WatchRuleSampleDto[];
  status: WatchQueryStatus;
  retry: () => void;
}

/** 规则列表接口不返回运行状态，只有详情视图按需拉取，避免每行一次请求 */
export function useWatchRuleState(ruleId: string): WatchRuleStateModel {
  const { apiClient } = useRuntime();
  const query = useQuery({
    queryKey: watchRuleStateQueryKey(ruleId),
    queryFn: () => fetchWatchRuleState(ruleId, apiClient),
    refetchInterval: 5000,
    throwOnError: false,
  });

  return {
    state: query.data?.state ?? null,
    samples: query.data?.samples ?? [],
    status: resolveQueryStatus({
      isLoading: query.isLoading,
      isError: query.isError,
      hasData: query.data !== undefined,
    }),
    retry: () => {
      void query.refetch();
    },
  };
}

export interface WatchRuleMutations {
  toggle: (rule: WatchRuleDto, enabled: boolean) => void;
  remove: (rule: WatchRuleDto) => void;
}

export function useWatchRuleMutations(): WatchRuleMutations {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const queryClient = useQueryClient();

  const invalidateRules = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['watch-rules'] });
  };

  const toggleMutation = useMutation({
    mutationFn: async ({ rule, enabled }: { rule: WatchRuleDto; enabled: boolean }) => {
      await updateWatchRule(rule.id, { enabled }, apiClient);
    },
    onSuccess: invalidateRules,
    onError: (error) => {
      toast.error(errorMessage(error));
      invalidateRules();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (rule: WatchRuleDto) => {
      await deleteWatchRule(rule.id, apiClient);
    },
    onSuccess: () => {
      toast.success(t('watch.toast.deleted'));
      invalidateRules();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });

  return {
    toggle: (rule, enabled) => toggleMutation.mutate({ rule, enabled }),
    remove: (rule) => deleteMutation.mutate(rule),
  };
}
