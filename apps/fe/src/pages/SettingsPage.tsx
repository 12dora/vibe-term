import { useMutation } from '@tanstack/react-query';
import {
  Bell,
  Monitor,
  Network,
  RotateCcw,
  Server,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
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
import { Reveal } from '@tmex/ui/motion';
import { Tabs, TabsList, TabsTrigger, pillTabTriggerClassName } from '@tmex/ui/tabs';
import { AISettingsTab } from './settings/ai-settings-tab';
import { DevicesAndFilesTab } from './settings/devices-and-files-tab';
import { GeneralSettingsTab } from './settings/general-settings-tab';
import { NodesTab } from './settings/nodes/nodes-tab';
import { NotificationSettingsTab } from './settings/notification-settings-tab';
import { useSiteSettingsForm } from './settings/use-site-settings-form';

type SettingsTab = 'general' | 'devicesAndFiles' | 'nodes' | 'notifications' | 'ai' | 'terminal';

const SETTINGS_TABS: SettingsTab[] = [
  'general',
  'devicesAndFiles',
  'nodes',
  'notifications',
  'ai',
  'terminal',
];

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (SETTINGS_TABS as string[]).includes(value);
}

export default function SettingsPage() {
  const { t } = useTranslation();
  // `?tab=` 是对外的深链（侧栏「节点」入口与老 /nodes 书签都落到这里）：初值从 URL 取，
  // 切换标签时用 replace 写回，避免每点一次都往历史里塞一条。
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    isSettingsTab(tabParam) ? tabParam : 'general'
  );
  const form = useSiteSettingsForm();

  // 已经停在设置页时再点侧栏「节点」入口只会换 query，组件不会重挂载——这里跟一次。
  useEffect(() => {
    if (isSettingsTab(tabParam)) setActiveTab(tabParam);
  }, [tabParam]);

  const selectTab = (value: SettingsTab) => {
    setActiveTab(value);
    setSearchParams(
      (params) => {
        params.set('tab', value);
        return params;
      },
      { replace: true }
    );
  };

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
      value: 'nodes',
      label: t('settings.tabGroup.nodes'),
      icon: Network,
      testId: 'settings-tab-nodes',
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
      <Tabs value={activeTab} onValueChange={(value) => selectTab(value as SettingsTab)}>
        <TabsList className="w-full gap-1 !justify-start overflow-x-auto rounded-xl border border-border/60 p-1.5 group-data-horizontal/tabs:h-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabItems.map((item) => {
            const Icon = item.icon;
            return (
              <TabsTrigger
                key={item.value}
                value={item.value}
                data-testid={item.testId}
                className={cn(pillTabTriggerClassName, 'min-w-max gap-2 px-3.5')}
              >
                <Icon />
                {item.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* 只让新挂载的面板入场，标签条本身不动（key 换了才重挂，动画才会重放）。
          多数标签页返回的是 Fragment，卡片之间的间距原本由外层 gap 提供——包一层就必须
          把同样的 gap 补回来，否则卡片会贴在一起。 */}
      <Reveal key={activeTab} className="flex min-w-0 flex-col gap-4 sm:gap-6">
        {activeTab === 'general' && <GeneralSettingsTab form={form} />}

        {activeTab === 'devicesAndFiles' && <DevicesAndFilesTab />}

        {activeTab === 'nodes' && <NodesTab />}

        {activeTab === 'notifications' && <NotificationSettingsTab form={form} />}

        {activeTab === 'ai' && <AISettingsTab />}

        {activeTab === 'terminal' && <TerminalSettingsTab />}
      </Reveal>
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
