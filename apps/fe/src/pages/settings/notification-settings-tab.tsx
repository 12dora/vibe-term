import { TelegramBotsTab } from '@vibeterm/panels/settings/telegram-bots';
import { WebhooksTab } from '@vibeterm/panels/settings/webhooks';
import { WeixinAccountsTab } from '@vibeterm/panels/settings/weixin-accounts';
import { memo } from 'react';
import { MeshNotificationCard } from './notifications/mesh-notification-card';
import { NotifyScopeBanner } from './notifications/notify-scope-banner';
import { SiteNotificationCard } from './notifications/site-notification-card';
import type { SiteSettingsForm } from './use-site-settings-form';

// 这几张卡片不吃站点设置草稿，却与它同在一个 Fragment 里：草稿每敲一键都会重渲染本标签，
// 无 props 的 memo 正好把它们挡在外面（各自内部还挂着自己的查询与列表）。
const MeshNotifications = memo(MeshNotificationCard);
const TelegramBots = memo(TelegramBotsTab);
const WeixinAccounts = memo(WeixinAccountsTab);
const Webhooks = memo(WebhooksTab);

interface NotificationSettingsTabProps {
  form: SiteSettingsForm;
}

export function NotificationSettingsTab({ form }: NotificationSettingsTabProps) {
  return (
    <>
      <NotifyScopeBanner />

      <SiteNotificationCard form={form} />

      <MeshNotifications />
      <TelegramBots />
      <WeixinAccounts />
      <Webhooks />
    </>
  );
}
