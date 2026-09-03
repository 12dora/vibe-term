import type { HubApi } from '@/node/hub-api';
import { refreshMeshNodes } from '@/node/mesh-nodes';
import { useMutation } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import type { SiteSettings } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  LanguagePreviewController,
  SiteSettingsDraft,
  SiteSettingsLinkage,
  SiteSettingsSavePlan,
} from './site-settings-form';
import { refreshUntilRenamed } from './site-settings-form';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SiteSettingsSaveOptions {
  plan: SiteSettingsSavePlan | null;
  hubApi: HubApi | null;
  linkage: SiteSettingsLinkage;
  languagePreview: LanguagePreviewController;
  draft: SiteSettingsDraft;
  applySettings: (settings: SiteSettings) => void;
  refreshSettings: () => Promise<SiteSettings>;
  refreshHub: () => void;
  /** 钉住已改成功、但站点设置还没回流的名字（同步宿主的 ref 与 state）。 */
  setPinnedName: (name: string | null) => void;
}

export interface SiteSettingsSave {
  save: () => void;
  isSaving: boolean;
}

export function useSiteSettingsSave({
  plan,
  hubApi,
  linkage,
  languagePreview,
  draft,
  applySettings,
  refreshSettings,
  refreshHub,
  setPinnedName,
}: SiteSettingsSaveOptions): SiteSettingsSave {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();

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

  const save = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation.mutate]);

  return { save, isSaving: saveMutation.isPending };
}
