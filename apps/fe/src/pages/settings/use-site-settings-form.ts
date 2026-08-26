import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SiteSettings } from '@tmex/shared';
import { useSiteStore } from '@tmex/stores';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '../../i18n';
import { parseApiError } from './parse-api-error';
import {
  type SiteSettingsDraft,
  buildSiteSettingsPayload,
  createDefaultSiteSettingsDraft,
  siteSettingsToDraft,
} from './site-settings-form';

interface SiteSettingsResponse {
  settings: SiteSettings;
}

export interface SiteSettingsForm {
  draft: SiteSettingsDraft;
  updateDraft: (patch: Partial<SiteSettingsDraft>) => void;
  showRefreshNotice: boolean;
  save: () => void;
  isSaving: boolean;
}

export function useSiteSettingsForm(): SiteSettingsForm {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { refreshSettings } = useSiteStore();

  const [draft, setDraft] = useState<SiteSettingsDraft>(() =>
    createDefaultSiteSettingsDraft(window.location.origin)
  );
  const [showRefreshNotice, setShowRefreshNotice] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ['site-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/site');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.loadFailed')));
      }
      return (await res.json()) as SiteSettingsResponse;
    },
  });

  const loadedSettings = settingsQuery.data?.settings;

  useEffect(() => {
    if (!loadedSettings) {
      return;
    }
    setDraft(siteSettingsToDraft(loadedSettings));
  }, [loadedSettings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/site', {
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['site-settings'] }),
        refreshSettings(),
      ]);
      toast.success(t('settings.settingsSaved'));
      if (loadedSettings?.language !== draft.language) {
        void i18n.changeLanguage(draft.language);
        setShowRefreshNotice(true);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const updateDraft = useCallback((patch: Partial<SiteSettingsDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const save = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation.mutate]);

  return {
    draft,
    updateDraft,
    showRefreshNotice,
    save,
    isSaving: saveMutation.isPending,
  };
}
