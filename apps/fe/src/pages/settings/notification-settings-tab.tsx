import { TelegramBotsTab } from '@tmex/panels/settings/telegram-bots';
import { WebhooksTab } from '@tmex/panels/settings/webhooks';
import { WeixinAccountsTab } from '@tmex/panels/settings/weixin-accounts';
import { Card, CardContent } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Switch } from '@tmex/ui/switch';
import { useTranslation } from 'react-i18next';
import { SettingsSaveButton } from './settings-save-button';
import type { SiteSettingsForm } from './use-site-settings-form';

interface NotificationSettingsTabProps {
  form: SiteSettingsForm;
}

export function NotificationSettingsTab({ form }: NotificationSettingsTabProps) {
  const { t } = useTranslation();
  const { draft, updateDraft } = form;

  return (
    <>
      <Card className="border-0 ring-0">
        <CardContent className="space-y-6 pt-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
              <div className="min-w-0 pr-2">
                <div className="text-sm font-medium">{t('settings.enableNotificationPush')}</div>
              </div>
              <Switch
                checked={draft.enableNotificationPush}
                onCheckedChange={(checked) =>
                  updateDraft({ enableNotificationPush: Boolean(checked) })
                }
                data-testid="settings-enable-notification-push"
              />
            </div>

            <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
              <div className="min-w-0 pr-2">
                <div className="text-sm font-medium">{t('settings.enableBellPush')}</div>
              </div>
              <Switch
                checked={draft.enableBellPush}
                onCheckedChange={(checked) => updateDraft({ enableBellPush: Boolean(checked) })}
                data-testid="settings-enable-bell-push"
              />
            </div>

            <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
              <div className="min-w-0 pr-2">
                <div className="text-sm font-medium">{t('settings.enableBellSound')}</div>
              </div>
              <Switch
                checked={draft.enableBellSound}
                onCheckedChange={(checked) => updateDraft({ enableBellSound: Boolean(checked) })}
                data-testid="settings-enable-bell-sound"
              />
            </div>

            <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
              <div className="min-w-0 pr-2">
                <div className="text-sm font-medium">
                  {t('settings.enableBrowserNotificationToast')}
                </div>
              </div>
              <Switch
                checked={draft.enableBrowserNotificationToast}
                onCheckedChange={(checked) =>
                  updateDraft({ enableBrowserNotificationToast: Boolean(checked) })
                }
                data-testid="settings-enable-browser-notification-toast"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="bell-throttle-input">
                {t('settings.bellThrottle')}
              </label>
              <Input
                id="bell-throttle-input"
                type="number"
                value={draft.bellThrottleSeconds}
                min={0}
                max={300}
                onChange={(event) =>
                  updateDraft({ bellThrottleSeconds: Number(event.target.value) })
                }
                className="min-h-10"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="notification-throttle-input">
                {t('settings.notificationThrottle')}
              </label>
              <Input
                id="notification-throttle-input"
                type="number"
                value={draft.notificationThrottleSeconds}
                min={0}
                max={300}
                onChange={(event) =>
                  updateDraft({ notificationThrottleSeconds: Number(event.target.value) })
                }
                className="min-h-10"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="ssh-reconnect-retries-input">
                {t('settings.sshReconnectMaxRetries')}
              </label>
              <Input
                id="ssh-reconnect-retries-input"
                type="number"
                value={draft.sshReconnectMaxRetries}
                min={0}
                max={20}
                onChange={(event) =>
                  updateDraft({ sshReconnectMaxRetries: Number(event.target.value) })
                }
                className="min-h-10"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor="ssh-reconnect-delay-input">
                {t('settings.sshReconnectDelay')}
              </label>
              <Input
                id="ssh-reconnect-delay-input"
                type="number"
                value={draft.sshReconnectDelaySeconds}
                min={1}
                max={300}
                onChange={(event) =>
                  updateDraft({ sshReconnectDelaySeconds: Number(event.target.value) })
                }
                className="min-h-10"
              />
            </div>
          </div>

          <SettingsSaveButton onSave={form.save} isSaving={form.isSaving} />
        </CardContent>
      </Card>

      <TelegramBotsTab />
      <WeixinAccountsTab />
      <WebhooksTab />
    </>
  );
}
