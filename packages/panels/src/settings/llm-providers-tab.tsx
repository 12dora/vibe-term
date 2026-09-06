import { useQuery } from '@tanstack/react-query';
import type { LlmProviderDto } from '@vibeterm/shared';
import { Loader2, Plus, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@vibeterm/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';

import { fetchLlmProviders } from '@vibeterm/api-client';
import { useRuntime } from '@vibeterm/stores/react';
import { useLlmDefaultsState } from './llm-defaults-state';
import { LlmModelSelect } from './llm-model-select';
import { LlmProviderFormModal } from './llm-provider-form-modal';
import { LlmProviderRow } from './llm-provider-row';
import { SETTINGS_STALE_MS } from './settings-query';

export function LlmProvidersTab() {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<LlmProviderDto | undefined>(undefined);

  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => fetchLlmProviders(t('settings.llm.loadFailed'), apiClient),
    staleTime: SETTINGS_STALE_MS,
  });

  const providers = providersQuery.data?.providers ?? [];

  const openAdd = () => {
    setEditingProvider(undefined);
    setModalOpen(true);
  };

  const openEdit = (provider: LlmProviderDto) => {
    setEditingProvider(provider);
    setModalOpen(true);
  };

  return (
    <>
      <Card className="border-0 ring-0" data-testid="llm-providers-section">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{t('settings.llm.title')}</CardTitle>
          <Button variant="secondary" data-testid="llm-provider-add" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('settings.llm.addProvider')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {providersQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!providersQuery.isLoading && providers.length === 0 && (
            <div className="text-sm text-muted-foreground" data-testid="llm-providers-empty">
              {t('settings.llm.empty')}
            </div>
          )}

          {providers.map((provider) => (
            <LlmProviderRow key={provider.id} provider={provider} onEdit={openEdit} />
          ))}
        </CardContent>
      </Card>

      <LlmProviderFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        provider={editingProvider}
      />

      <LlmDefaultsCard providers={providers} />
    </>
  );
}

interface LlmDefaultsCardProps {
  providers: LlmProviderDto[];
}

const NONE_PROVIDER_VALUE = '__none__';

function LlmDefaultsCard({ providers }: LlmDefaultsCardProps) {
  const { t } = useTranslation();
  const { draft, selectProvider, selectModel, save, isLoading, isSaving } =
    useLlmDefaultsState(providers);

  const enabledProviders = providers.filter((provider) => provider.enabled);
  const selectedProvider = providers.find((provider) => provider.id === draft.providerId);

  return (
    <Card className="border-0 ring-0" data-testid="llm-defaults-section">
      <CardHeader>
        <CardTitle>{t('settings.llm.defaults')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="llm-default-provider-select">
              {t('settings.llm.defaultProvider')}
            </label>
            <Select
              value={draft.providerId ?? NONE_PROVIDER_VALUE}
              onValueChange={(value) => {
                if (!value) return;
                selectProvider(value === NONE_PROVIDER_VALUE ? null : value);
              }}
            >
              <SelectTrigger
                id="llm-default-provider-select"
                data-testid="llm-default-provider-select"
                className="h-9 w-full"
              >
                <SelectValue>
                  {selectedProvider?.name ?? t('settings.llm.defaultProviderNone')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_PROVIDER_VALUE}>
                  {t('settings.llm.defaultProviderNone')}
                </SelectItem>
                {enabledProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="llm-default-model-select">
              {t('settings.llm.defaultModel')}
            </label>
            <LlmModelSelect
              id="llm-default-model-select"
              testId="llm-default-model-select"
              providers={providers}
              providerId={draft.providerId}
              modelId={draft.modelId || null}
              allowNone
              onChange={selectModel}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            variant="secondary"
            data-testid="llm-defaults-save"
            onClick={save}
            disabled={isSaving || isLoading}
            className="w-full sm:w-auto"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('settings.llm.saveDefaults')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
