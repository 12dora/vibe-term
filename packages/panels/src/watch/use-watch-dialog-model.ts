// WatchDialog 状态机：视图切换、规则查询、启停/删除 mutation、关闭重置与通知授权提示。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteWatchRule,
  fetchWatchRules,
  updateWatchRule,
  watchRulesQueryKey,
} from '@tmex/api-client';
import type { WatchRuleDto } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export type WatchDialogView =
  | { mode: 'list' }
  | { mode: 'form'; rule: WatchRuleDto | null }
  | { mode: 'state'; rule: WatchRuleDto };

export interface UseWatchDialogModelOptions {
  open: boolean;
  deviceId: string;
  paneId: string;
}

export interface WatchDialogModel {
  view: WatchDialogView;
  setView: (view: WatchDialogView) => void;
  rules: WatchRuleDto[];
  isLoading: boolean;
  showNotifBanner: boolean;
  dismissNotifBanner: () => void;
  requestNotifPermission: () => void;
  deleteCandidate: WatchRuleDto | null;
  setDeleteCandidate: (rule: WatchRuleDto | null) => void;
  confirmDelete: () => void;
  toggleRule: (rule: WatchRuleDto, enabled: boolean) => void;
  handleSaved: (created: boolean) => void;
}

/** 列表/表单/状态三种视图各自的标题 key。 */
export function watchDialogTitleKey(view: WatchDialogView): string {
  if (view.mode === 'form') {
    return view.rule ? 'watch.form.editTitle' : 'watch.form.createTitle';
  }
  if (view.mode === 'state') {
    return 'watch.state.title';
  }
  return 'watch.title';
}

/** 新建规则后，浏览器通知权限仍为默认态时提示用户授权。 */
export function shouldPromptNotifPermission(created: boolean): boolean {
  return created && typeof Notification !== 'undefined' && Notification.permission === 'default';
}

export function useWatchDialogModel({
  open,
  deviceId,
  paneId,
}: UseWatchDialogModelOptions): WatchDialogModel {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();
  const [view, setView] = useState<WatchDialogView>({ mode: 'list' });
  const [deleteCandidate, setDeleteCandidate] = useState<WatchRuleDto | null>(null);
  const [showNotifBanner, setShowNotifBanner] = useState(false);

  useEffect(() => {
    if (!open) {
      setView({ mode: 'list' });
      setDeleteCandidate(null);
      setShowNotifBanner(false);
    }
  }, [open]);

  const rulesQuery = useQuery({
    queryKey: watchRulesQueryKey(deviceId, paneId),
    queryFn: () => fetchWatchRules(deviceId, paneId, apiClient),
    enabled: open,
    throwOnError: false,
  });

  const invalidateRules = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['watch-rules'] });
  };

  const toggleMutation = useMutation({
    mutationFn: async ({ rule, enabled }: { rule: WatchRuleDto; enabled: boolean }) => {
      await updateWatchRule(rule.id, { enabled }, apiClient);
    },
    onSuccess: invalidateRules,
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
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
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  return {
    view,
    setView,
    rules: rulesQuery.data ?? [],
    isLoading: rulesQuery.isLoading,
    showNotifBanner,
    dismissNotifBanner: () => setShowNotifBanner(false),
    requestNotifPermission: () => {
      void Notification.requestPermission().finally(() => setShowNotifBanner(false));
    },
    deleteCandidate,
    setDeleteCandidate,
    confirmDelete: () => {
      if (deleteCandidate) {
        deleteMutation.mutate(deleteCandidate);
      }
      setDeleteCandidate(null);
    },
    toggleRule: (rule, enabled) => toggleMutation.mutate({ rule, enabled }),
    handleSaved: (created) => {
      invalidateRules();
      setView({ mode: 'list' });
      if (shouldPromptNotifPermission(created)) {
        setShowNotifBanner(true);
      }
    },
  };
}
