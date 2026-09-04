import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SiteSettings } from '@tmex/shared';
import { useRuntime, useSiteStore } from '@tmex/stores/react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  siteSettingsLinkage,
  siteSettingsToDraft,
} from './site-settings-form';
import { useNodeRenameChannel } from './use-node-rename-channel';
import { useSiteSettingsSave } from './use-site-settings-save';

export interface SiteSettingsForm {
  draft: SiteSettingsDraft;
  updateDraft: (patch: Partial<SiteSettingsDraft>) => void;
  save: () => void;
  isSaving: boolean;
  /** 站点名称 / 访问地址与 mesh 节点的联动状态；未加载时按「不联动」处理。 */
  linkage: SiteSettingsLinkage;
  /** 联动改名当前可用：改名通道就绪，且知道要改哪个节点。 */
  canRenameNode: boolean;
  /** 中继模式下改名要一次凭据；宿主必须把这个对话框挂进页面。 */
  renameDialog: ReactElement | null;
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
  const queryClient = useQueryClient();
  const { controlsBrowserPrefs } = useRuntime();
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

  const { t } = useTranslation();
  const {
    renameNode,
    canRenameNode,
    refreshHub,
    dialog: renameDialog,
  } = useNodeRenameChannel(linkage, { t });

  // 已改成功、但站点设置还没回流的名字。ref 与 state 各有用途：ref 供注水效应读到最新值
  // （它不该因为钉住名字而重跑，否则会把用户其它未保存的改动一起冲掉），state 供基线重算。
  const [pinnedName, setPinnedName] = useState<string | null>(null);
  const pinnedNameRef = useRef<string | null>(null);
  pinnedNameRef.current = pinnedName;
  const pinName = useCallback((name: string | null) => {
    pinnedNameRef.current = name;
    setPinnedName(name);
  }, []);

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

  const { save, isSaving } = useSiteSettingsSave({
    plan,
    renameNode,
    linkage,
    languagePreview,
    draft,
    applySettings,
    refreshSettings,
    refreshHub,
    setPinnedName: pinName,
  });

  const updateDraft = useCallback(
    (patch: Partial<SiteSettingsDraft>) => {
      setDraft((prev) => ({ ...prev, ...patch }));
      languagePreview.preview(patch.language);
    },
    [languagePreview]
  );

  useEffect(() => () => languagePreview.release(), [languagePreview]);

  return {
    draft,
    updateDraft,
    save,
    isSaving,
    linkage,
    canRenameNode,
    renameDialog,
    canSave: plan !== null && hasSiteSettingsChanges(plan),
  };
}
