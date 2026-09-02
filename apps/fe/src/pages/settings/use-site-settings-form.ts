import type { HubApi } from '@/node/hub-api';
import { useMeshHubs } from '@/node/mesh-hubs';
import { refreshMeshNodes, useHubNode, useMeshNodes } from '@/node/mesh-nodes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
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
  planSiteSettingsSave,
  siteSettingsLinkage,
  siteSettingsToDraft,
} from './site-settings-form';

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

interface NodeRenameChannel {
  hubApi: HubApi | null;
  canRenameNode: boolean;
  refreshHub: () => void;
}

/**
 * 联动改名走 entry 的 hub 控制面。非联动（standalone / 老服务端）下这三个 hook 全部空转，
 * 不发任何 `/api/mesh/*` 请求；hub 集合的轮询归节点管理页所有，这里只要一份 hubApi。
 */
function useNodeRenameChannel(linkage: SiteSettingsLinkage): NodeRenameChannel {
  const linked = linkage.siteNameLinkedToNode;
  const { nodes } = useMeshNodes({ enabled: linked });
  const hub = useHubNode(nodes, { enabled: linked, pollIntervalMs: 0 });
  const hubs = useMeshHubs({ enabled: linked });
  return {
    hubApi: hub.hubApi,
    canRenameNode: Boolean(
      linked && linkage.nodeId && hub.hubApi && hub.online && !hubs.writesBlocked
    ),
    refreshHub: hub.refresh,
  };
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

  useEffect(() => {
    if (!baseline) {
      return;
    }
    setDraft(baseline);
    languagePreview.hydrate(baseline.language);
  }, [baseline, languagePreview]);

  const plan = useMemo(
    () => (baseline ? planSiteSettingsSave(baseline, draft, linkage) : null),
    [baseline, draft, linkage]
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<{ renamed: boolean }> => {
      if (!plan) return { renamed: false };
      if (plan.renameNodeTo) {
        if (!hubApi || !linkage.nodeId) throw new Error(t('settings.general.nameLinkedLocked'));
        await hubApi.rename(linkage.nodeId, plan.renameNodeTo);
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
      return { renamed: plan.renameNodeTo !== null };
    },
    onSuccess: async ({ renamed }) => {
      // 先认账再重拉：重拉回来之前若用户已离开设置页，不该把刚保存的语言当预览回退掉
      languagePreview.commit(draft.language);
      // 改名落在 hub 上，站点设置的 `siteName` 要等重拉才跟上；mesh 列表同理。
      if (renamed) {
        void refreshMeshNodes();
        refreshHub();
      }
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
    linkage,
    canRenameNode,
    canSave: plan !== null && hasSiteSettingsChanges(plan),
  };
}
