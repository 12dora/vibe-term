import { useMutation } from '@tanstack/react-query';
import { Bell, Monitor, RotateCcw, Server, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { parseApiError } from '@tmex/api-client';
import { TerminalSettingsTab } from '@tmex/panels/settings';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@tmex/ui/tabs';
import { AISettingsTab } from './settings/ai-settings-tab';
import { DevicesAndFilesTab } from './settings/devices-and-files-tab';
import { GeneralSettingsTab } from './settings/general-settings-tab';
import { NotificationSettingsTab } from './settings/notification-settings-tab';
import { useSiteSettingsForm } from './settings/use-site-settings-form';

// 灰色轨道(bg-muted)上嵌一个更亮的圆角药丸：亮色用 bg-background(白)，暗色用更亮的半透明覆盖，去边框。
// rounded-lg 与外层 rounded-xl 轨道同心收敛。（原侧边栏 Tabs 样式，侧边栏平铺后仅设置页使用）
const tabTriggerClassName =
  "rounded-lg data-active:bg-background data-active:text-foreground data-active:border-transparent group-data-[variant=default]/tabs-list:data-active:shadow-none dark:data-active:bg-input/60 dark:data-active:border-transparent text-[13px] transition-colors duration-200 [&_svg:not([class*='size-'])]:size-[15px]";

type SettingsTab = 'general' | 'devicesAndFiles' | 'notifications' | 'ai' | 'terminal';

export default function SettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const form = useSiteSettingsForm();

  const tabItems: {
    value: SettingsTab;
    label: string;
    icon: typeof SettingsIcon;
    testId: string;
  }[] = [
    {
      value: 'general',
      label: t('settings.tabGroup.general'),
      icon: SettingsIcon,
      testId: 'settings-tab-general',
    },
    {
      value: 'terminal',
      label: t('settings.tabGroup.terminal'),
      icon: Monitor,
      testId: 'settings-tab-terminal',
    },
    {
      value: 'devicesAndFiles',
      label: t('settings.tabGroup.devicesAndFiles'),
      icon: Server,
      testId: 'settings-tab-devicesAndFiles',
    },
    {
      value: 'notifications',
      label: t('settings.tabGroup.notifications'),
      icon: Bell,
      testId: 'settings-tab-notifications',
    },
    {
      value: 'ai',
      label: t('settings.tabGroup.ai'),
      icon: Sparkles,
      testId: 'settings-tab-ai',
    },
  ];

  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:gap-6 sm:p-5"
      data-testid="settings-page"
    >
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SettingsTab)}>
        <TabsList className="w-full gap-1 !justify-start overflow-x-auto rounded-xl border border-border/60 p-1.5 group-data-horizontal/tabs:h-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabItems.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger
                key={item.value}
                value={item.value}
                data-testid={item.testId}
                className={cn(tabTriggerClassName, 'min-w-max gap-2 px-3.5')}
              >
                <Icon />
                {item.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {activeTab === 'general' && <GeneralSettingsTab form={form} />}

      {activeTab === 'devicesAndFiles' && <DevicesAndFilesTab />}

      {activeTab === 'notifications' && <NotificationSettingsTab form={form} />}

      {activeTab === 'ai' && <AISettingsTab />}

      {activeTab === 'terminal' && <TerminalSettingsTab />}
    </div>
  );
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.settings')}</>;
}

// Page actions component
export function PageActions() {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

  const restartMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.fetch('/api/settings/restart', { method: 'POST' });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t('settings.restartFailed')));
      }
    },
    onSuccess: () => {
      toast.success(t('settings.restartScheduled'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setShowRestartConfirm(true)}
        disabled={restartMutation.isPending}
        aria-label={t('settings.restartGateway')}
        title={t('settings.restartGateway')}
        className="text-destructive hover:text-destructive hover:bg-destructive/10"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>

      <AlertDialog open={showRestartConfirm} onOpenChange={setShowRestartConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.restartGateway')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.restartConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowRestartConfirm(false)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                restartMutation.mutate();
                setShowRestartConfirm(false);
              }}
            >
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
