import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import type { GetSiteSettingsResponse } from '@tmex/shared';
import { useRuntime, useSiteStore } from '@tmex/stores/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '../../i18n';
import {
  type LanguagePreviewController,
  type SiteSettingsDraft,
  buildSiteSettingsPayload,
  createDefaultSiteSettingsDraft,
  createLanguagePreviewController,
  siteSettingsToDraft,
} from './site-settings-form';

export interface SiteSettingsForm {
  draft: SiteSettingsDraft;
  updateDraft: (patch: Partial<SiteSettingsDraft>) => void;
  save: () => void;
  isSaving: boolean;
}

export function useSiteSettingsForm(): SiteSettingsForm {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient, controlsBrowserPrefs } = useRuntime();
  const refreshSettings = useSiteStore((state) => state.refreshSettings);

  const [draft, setDraft] = useState<SiteSettingsDraft>(() =>
    createDefaultSiteSettingsDraft(window.location.origin)
  );

  const controlsBrowserPrefsRef = useRef(controlsBrowserPrefs);
  controlsBrowserPrefsRef.current = controlsBrowserPrefs;

  // 控制器需在整个挂载期间保持同一个（卸载清理要读它累积的「已保存语言」），故懒建一次存进 ref
  const languagePreviewRef = useRef<LanguagePreviewController | null>(null);
  if (!languagePreviewRef.current) {
    languagePreviewRef.current = createLanguagePreviewController({
      controlsBrowserPrefs: () => controlsBrowserPrefsRef.current,
      currentLanguage: () => i18n.language,
      changeLanguage: (language) => {
        // i18next 异步拉对应 locale chunk，加载完触发 languageChanged，react-i18next 重渲染整页
        void i18n.changeLanguage(language);
      },
    });
  }
  const languagePreview = languagePreviewRef.current;

  const settingsQuery = useQuery({
    queryKey: ['site-settings'],
    // 窗口重新聚焦的静默重拉会用服务端值覆盖未保存的草稿，表单页只在挂载时拉一次
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const res = await apiClient.fetch('/api/settings/site');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.loadFailed')));
      }
      return (await res.json()) as GetSiteSettingsResponse;
    },
  });

  const loadedSettings = settingsQuery.data?.settings;

  useEffect(() => {
    if (!loadedSettings) {
      return;
    }
    const next = siteSettingsToDraft(loadedSettings);
    setDraft(next);
    languagePreview.hydrate(next.language);
  }, [loadedSettings, languagePreview]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.fetch('/api/settings/site', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildSiteSettingsPayload(draft)),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.saveFailed')));
      }
    },
    onSuccess: async () => {
      // 先认账再重拉：重拉回来之前若用户已离开设置页，不该把刚保存的语言当预览回退掉
      languagePreview.commit(draft.language);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['site-settings'] }),
        refreshSettings(),
      ]);
      toast.success(t('settings.settingsSaved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const updateDraft = useCallback(
    (patch: Partial<SiteSettingsDraft>) => {
      setDraft((prev) => ({ ...prev, ...patch }));
      languagePreview.preview(patch.language);
    },
    [languagePreview]
  );

  useEffect(() => () => languagePreview.release(), [languagePreview]);

  const save = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation.mutate]);

  return {
    draft,
    updateDraft,
    save,
    isSaving: saveMutation.isPending,
  };
}
