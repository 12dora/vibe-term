import { refreshMeshNodes } from '@/node/mesh-nodes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import type { SiteSettings } from '@tmex/shared';
import { useRuntime, useSiteStore } from '@tmex/stores/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '../../i18n';
import { SETTINGS_STALE_MS } from './data-prefetch';
import {
  type LanguagePreviewController,
  type SiteSettingsDraft,
  type SiteSettingsLinkage,
  UNLINKED_SITE_SETTINGS,
  createDefaultSiteSettingsDraft,
  createLanguagePreviewController,
  hasSiteSettingsChanges,
  pinSiteName,
  planSiteSettingsSave,
  refreshUntilRenamed,
  siteSettingsLinkage,
  siteSettingsToDraft,
} from './site-settings-form';
import { useNodeRenameChannel } from './use-node-rename-channel';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SiteSettingsForm {
  draft: SiteSettingsDraft;
  updateDraft: (patch: Partial<SiteSettingsDraft>) => void;
  save: () => void;
  isSaving: boolean;
  /** 站点名称 / 访问地址与 mesh 节点的联动状态；未加载时按「不联动」处理。 */
  linkage: SiteSettingsLinkage;
  /** 联动改名当前可用：有可写 hub，且知道要改哪个节点。 */
  canRenameNode: boolean;
  /** 相对已保存值有实际改动，保存按钮据此可点。 */
  canSave: boolean;
}

export interface SiteSettingsFormOptions {
  /**
   * 是否需要站点设置。设置页七个标签里只有「通用」「通知」用得上，其余标签下不拉数据；
   * 草稿与语言预览仍留在本 hook 里（宿主常挂），切到无关标签再切回来不会丢未保存的改动。
   */
  enabled?: boolean;
}

/**
 * 语言实时预览控制器：整个挂载期间保持同一个（卸载清理要读它累积的「已保存语言」），
 * 因此懒建一次存进 ref；`controlsBrowserPrefs` 每次渲染刷新，控制器读的永远是最新值。
 */
function useLanguagePreview(controlsBrowserPrefs: boolean): LanguagePreviewController {
  const controlsBrowserPrefsRef = useRef(controlsBrowserPrefs);
  controlsBrowserPrefsRef.current = controlsBrowserPrefs;

  const ref = useRef<LanguagePreviewController | null>(null);
  if (!ref.current) {
    ref.current = createLanguagePreviewController({
      controlsBrowserPrefs: () => controlsBrowserPrefsRef.current,
      currentLanguage: () => i18n.language,
      changeLanguage: (language) => {
        // i18next 异步拉对应 locale chunk，加载完触发 languageChanged，react-i18next 重渲染整页
        void i18n.changeLanguage(language);
      },
    });
  }
  return ref.current;
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

  const languagePreview = useLanguagePreview(controlsBrowserPrefs);

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
  const baseline = useMemo(
    () => (loadedSettings ? siteSettingsToDraft(loadedSettings) : null),
    [loadedSettings]
  );
  const linkage = useMemo(
    () => (loadedSettings ? siteSettingsLinkage(loadedSettings) : UNLINKED_SITE_SETTINGS),
    [loadedSettings]
  );

  const { hubApi, canRenameNode, refreshHub } = useNodeRenameChannel(linkage);

  // 已改成功、但站点设置还没回流的名字。ref 与 state 各有用途：ref 供注水效应读到最新值
  // （它不该因为钉住名字而重跑，否则会把用户其它未保存的改动一起冲掉），state 供基线重算。
  const [pinnedName, setPinnedName] = useState<string | null>(null);
  const pinnedNameRef = useRef<string | null>(null);
  pinnedNameRef.current = pinnedName;

  useEffect(() => {
    if (!baseline) {
      return;
    }
    // 远端 node 的新名字要等 hub 下一次 node.list 才回流：重拉回来的旧名字不许盖掉它
    setDraft(pinSiteName(baseline, pinnedNameRef.current));
    languagePreview.hydrate(baseline.language);
  }, [baseline, languagePreview]);

  const savedBaseline = useMemo(
    () => (baseline ? pinSiteName(baseline, pinnedName) : null),
    [baseline, pinnedName]
  );

  const plan = useMemo(
    () => (savedBaseline ? planSiteSettingsSave(savedBaseline, draft, linkage) : null),
    [savedBaseline, draft, linkage]
  );

  const applySettings = useCallback(
    (settings: SiteSettings) => {
      // 重拉结果就是权威数据，直接喂给查询缓存；再 invalidate 一次只会对同一端点重复 GET
      queryClient.setQueryData(['site-settings'], settings);
    },
    [queryClient]
  );

  // 本次保存里已经改成功的名字（成败都要善后，因此不放返回值里）。
  const renamedInAttempt = useRef<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      renamedInAttempt.current = null;
      if (!plan) return;
      if (plan.renameNodeTo) {
        if (!hubApi || !linkage.nodeId) throw new Error(t('settings.general.nameLinkedLocked'));
        await hubApi.rename(linkage.nodeId, plan.renameNodeTo);
        // 改名已经落地：立刻推进基线，后面的 PATCH 再失败，重试时也不会又改一次名
        renamedInAttempt.current = plan.renameNodeTo;
        pinnedNameRef.current = plan.renameNodeTo;
        setPinnedName(plan.renameNodeTo);
      }
      if (plan.patch) {
        const res = await apiClient.fetch('/api/settings/site', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(plan.patch),
        });
        if (!res.ok) {
          throw new Error(await parseApiError(res, t('settings.saveFailed')));
        }
      }
    },
    onSuccess: () => {
      // 先认账再重拉：重拉回来之前若用户已离开设置页，不该把刚保存的语言当预览回退掉
      languagePreview.commit(draft.language);
      toast.success(t('settings.settingsSaved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
    onSettled: async (_data, error) => {
      const renamed = renamedInAttempt.current;
      renamedInAttempt.current = null;
      if (!renamed) {
        // 什么都没写成就别再多打一次 GET
        if (!error) applySettings(await refreshSettings());
        return;
      }
      // 改名落在 hub 上，mesh 列表与 hub 视图都要跟上
      void refreshMeshNodes();
      refreshHub();
      const settled = await refreshUntilRenamed(renamed, {
        refresh: refreshSettings,
        apply: applySettings,
        wait: sleep,
      });
      // 名字已回流：基线本身就是新值，钉子可以撤掉
      if (settled) setPinnedName(null);
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
    linkage,
    canRenameNode,
    canSave: plan !== null && hasSiteSettingsChanges(plan),
  };
}
