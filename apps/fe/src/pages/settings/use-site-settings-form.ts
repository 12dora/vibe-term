import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import { useRuntime, useSiteStore } from '@tmex/stores/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '../../i18n';
import { SETTINGS_STALE_MS } from './data-prefetch';
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

export interface SiteSettingsFormOptions {
  /**
   * 是否需要站点设置。设置页七个标签里只有「通用」「通知」用得上，其余标签下不拉数据；
   * 草稿与语言预览仍留在本 hook 里（宿主常挂），切到无关标签再切回来不会丢未保存的改动。
   */
  enabled?: boolean;
}

export function useSiteSettingsForm(options: SiteSettingsFormOptions = {}): SiteSettingsForm {
  const { enabled = true } = options;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient, controlsBrowserPrefs } = useRuntime();
  const ensureFreshSettings = useSiteStore((state) => state.ensureFreshSettings);
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
    enabled,
    // 窗口重新聚焦的静默重拉会用服务端值覆盖未保存的草稿，表单页只在挂载时拉一次
    refetchOnWindowFocus: false,
    // 站点设置只在这个表单里改；切到别的标签再切回来（默认 5 秒就过期）不必再问一遍
    staleTime: SETTINGS_STALE_MS,
    // 经 site store 取数：它不吃缓存（数据照样新鲜），但与侧栏的引导请求并发时共享同一次 GET
    queryFn: () => ensureFreshSettings(),
  });

  const loadedSettings = settingsQuery.data;

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
      // 保存后只重拉一次：store 的重拉结果就是权威数据，直接喂给查询缓存。
      // 再 invalidate 一次只会对同一个端点重复 GET。
      const settings = await refreshSettings();
      queryClient.setQueryData(['site-settings'], settings);
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
