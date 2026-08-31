import { useQuery } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import type { ListTelegramBotsResponse, TelegramBotWithStats } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';

import { SETTINGS_STALE_MS } from './settings-query';
import { TelegramBotFormModal } from './telegram-bot-form-modal';
import { TelegramBotRow } from './telegram-bot-row';

export function TelegramBotsTab() {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<TelegramBotWithStats | undefined>(undefined);

  const botsQuery = useQuery({
    queryKey: ['telegram-bots'],
    queryFn: async () => {
      const res = await apiClient.fetch('/api/settings/telegram/bots');
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('telegram.loadBotsFailed')));
      }
      return (await res.json()) as ListTelegramBotsResponse;
    },
    staleTime: SETTINGS_STALE_MS,
  });

  const bots = botsQuery.data?.bots ?? [];

  const openAdd = () => {
    setEditingBot(undefined);
    setModalOpen(true);
  };

  const openEdit = (bot: TelegramBotWithStats) => {
    setEditingBot(bot);
    setModalOpen(true);
  };

  return (
    <>
      <Card className="border-0 ring-0">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{t('telegram.title')}</CardTitle>
          <Button variant="secondary" data-testid="telegram-add-bot" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('telegram.addBot')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {botsQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!botsQuery.isLoading && bots.length === 0 && (
            <div className="text-sm text-muted-foreground">{t('telegram.noBots')}</div>
          )}

          {bots.map((bot) => (
            <TelegramBotRow key={bot.id} bot={bot} onEdit={openEdit} />
          ))}
        </CardContent>
      </Card>

      <TelegramBotFormModal open={modalOpen} onOpenChange={setModalOpen} bot={editingBot} />
    </>
  );
}
