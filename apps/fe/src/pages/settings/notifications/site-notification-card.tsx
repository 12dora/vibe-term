// 站点级通知开关与频控：四个开关 + 四个阈值输入，全部落在站点设置草稿上。
// 从「通知」标签里拆出来，标签本身只负责编排卡片顺序。

import { Card, CardContent } from '@vibeterm/ui/card';
import { Input } from '@vibeterm/ui/input';
import { Switch } from '@vibeterm/ui/switch';
import { useTranslation } from 'react-i18next';
import { SettingsSaveButton } from '../settings-save-button';
import type { SiteSettingsDraft } from '../site-settings-form';
import type { SiteSettingsForm } from '../use-site-settings-form';

type BooleanField =
  | 'enableNotificationPush'
  | 'enableBellPush'
  | 'enableBellSound'
  | 'enableBrowserNotificationToast';
type NumberField =
  | 'bellThrottleSeconds'
  | 'notificationThrottleSeconds'
  | 'sshReconnectMaxRetries'
  | 'sshReconnectDelaySeconds';

const TOGGLES: readonly { field: BooleanField; labelKey: string; testId: string }[] = [
  {
    field: 'enableNotificationPush',
    labelKey: 'settings.enableNotificationPush',
    testId: 'settings-enable-notification-push',
  },
  {
    field: 'enableBellPush',
    labelKey: 'settings.enableBellPush',
    testId: 'settings-enable-bell-push',
  },
  {
    field: 'enableBellSound',
    labelKey: 'settings.enableBellSound',
    testId: 'settings-enable-bell-sound',
  },
  {
    field: 'enableBrowserNotificationToast',
    labelKey: 'settings.enableBrowserNotificationToast',
    testId: 'settings-enable-browser-notification-toast',
  },
];

const THRESHOLDS: readonly {
  field: NumberField;
  id: string;
  labelKey: string;
  min: number;
  max: number;
}[] = [
  {
    field: 'bellThrottleSeconds',
    id: 'bell-throttle-input',
    labelKey: 'settings.bellThrottle',
    min: 0,
    max: 300,
  },
  {
    field: 'notificationThrottleSeconds',
    id: 'notification-throttle-input',
    labelKey: 'settings.notificationThrottle',
    min: 0,
    max: 300,
  },
  {
    field: 'sshReconnectMaxRetries',
    id: 'ssh-reconnect-retries-input',
    labelKey: 'settings.sshReconnectMaxRetries',
    min: 0,
    max: 20,
  },
  {
    field: 'sshReconnectDelaySeconds',
    id: 'ssh-reconnect-delay-input',
    labelKey: 'settings.sshReconnectDelay',
    min: 1,
    max: 300,
  },
];

type UpdateDraft = (patch: Partial<SiteSettingsDraft>) => void;

function NotificationToggles({
  draft,
  updateDraft,
}: { draft: SiteSettingsDraft; updateDraft: UpdateDraft }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {TOGGLES.map((item) => (
        <div
          key={item.field}
          className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5"
        >
          <div className="min-w-0 pr-2">
            <div className="text-sm font-medium">{t(item.labelKey)}</div>
          </div>
          <Switch
            checked={draft[item.field]}
            onCheckedChange={(checked) => updateDraft({ [item.field]: Boolean(checked) })}
            data-testid={item.testId}
          />
        </div>
      ))}
    </div>
  );
}

function NotificationThresholds({
  draft,
  updateDraft,
}: { draft: SiteSettingsDraft; updateDraft: UpdateDraft }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
      {THRESHOLDS.map((item) => (
        <div key={item.field} className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={item.id}>
            {t(item.labelKey)}
          </label>
          <Input
            id={item.id}
            type="number"
            value={draft[item.field]}
            min={item.min}
            max={item.max}
            onChange={(event) => updateDraft({ [item.field]: Number(event.target.value) })}
            className="min-h-10"
          />
        </div>
      ))}
    </div>
  );
}

export function SiteNotificationCard({ form }: { form: SiteSettingsForm }) {
  const { draft, updateDraft } = form;
  return (
    <Card className="border-0 ring-0">
      <CardContent className="space-y-6 pt-6">
        <NotificationToggles draft={draft} updateDraft={updateDraft} />
        <NotificationThresholds draft={draft} updateDraft={updateDraft} />
        <SettingsSaveButton onSave={form.save} isSaving={form.isSaving} />
      </CardContent>
    </Card>
  );
}
