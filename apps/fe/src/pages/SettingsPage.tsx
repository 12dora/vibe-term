import { useMutation } from '@tanstack/react-query';
import {
  Bell,
  Globe,
  Loader2,
  Monitor,
  Network,
  RadioTower,
  RotateCcw,
  Server,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { Suspense, memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { lazyChunk } from '@/lazy-chunk';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { nodeQueryClient } from '@/node/node-runtimes';
import { parseApiError } from '@tmex/api-client';
import { useOptionalRuntime, useRuntime } from '@tmex/stores/react';
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
import {
  type ChunkPreloadTarget,
  preloadChunk,
  startIdleChunkPreload,
} from './settings/chunk-preload';
import { prefetchTabData } from './settings/data-prefetch';
import { useRelayAvailability } from './settings/relay/relay-status-store';
import { useSiteSettingsForm } from './settings/use-site-settings-form';

// 每个标签页独立成块：进设置页只下载当前标签的代码，切换过一次后 React.lazy 缓存模块，之后切换是同步的。
// loader 单独命名是为了让预热（chunk-preload）复用同一个函数引用——绝不能改成静态 import，
// 那样七个标签的代码会全部回到入口 chunk 里。
const loadGeneralSettingsTab = () =>
  import('./settings/general-settings-tab').then((m) => m.GeneralSettingsTab);
const loadDevicesAndFilesTab = () =>
  import('./settings/devices-and-files-tab').then((m) => m.DevicesAndFilesTab);
const loadNodesTab = () => import('./settings/nodes/nodes-tab').then((m) => m.NodesTab);
const loadNotificationSettingsTab = () =>
  import('./settings/notification-settings-tab').then((m) => m.NotificationSettingsTab);
const loadAISettingsTab = () => import('./settings/ai-settings-tab').then((m) => m.AISettingsTab);
const loadTerminalSettingsTab = () =>
  import('@tmex/panels/settings/terminal').then((m) => m.TerminalSettingsTab);
const loadRemoteAccessTab = () =>
  import('./settings/remote-access/remote-access-tab').then((m) => m.RemoteAccessTab);
const loadRelayTab = () => import('./settings/relay/relay-tab').then((m) => m.RelayTab);

const GeneralSettingsTab = lazyChunk(loadGeneralSettingsTab);
const DevicesAndFilesTab = lazyChunk(loadDevicesAndFilesTab);
const NodesTab = lazyChunk(loadNodesTab);
const NotificationSettingsTab = lazyChunk(loadNotificationSettingsTab);
const AISettingsTab = lazyChunk(loadAISettingsTab);
const TerminalSettingsTab = lazyChunk(loadTerminalSettingsTab);
const RemoteAccessTab = lazyChunk(loadRemoteAccessTab);
const RelayTab = lazyChunk(loadRelayTab);

export type SettingsTab =
  | 'general'
  | 'devicesAndFiles'
  | 'nodes'
  | 'notifications'
  | 'ai'
  | 'terminal'
  | 'remoteAccess'
  | 'relay';

/** 每台机器都有的标签：空闲预热与 `chunkPreloadOrder` 只认这一组。 */
const SETTINGS_TABS: SettingsTab[] = [
  'general',
  'devicesAndFiles',
  'nodes',
  'notifications',
  'ai',
  'terminal',
  'remoteAccess',
];

/**
 * 按角色出现的标签：`relay` 只在本机带 relay 角色时才有（门禁见 `useRelayAvailability`）。
 * **不进** `SETTINGS_TABS`——绝大多数机器不是中继，没理由让每次进设置页都把这块 chunk 拖下来。
 */
const OPTIONAL_SETTINGS_TABS: SettingsTab[] = ['relay'];

const TAB_CHUNK_LOADERS: Record<SettingsTab, ChunkPreloadTarget> = {
  general: loadGeneralSettingsTab,
  devicesAndFiles: loadDevicesAndFilesTab,
  nodes: loadNodesTab,
  notifications: loadNotificationSettingsTab,
  ai: loadAISettingsTab,
  terminal: loadTerminalSettingsTab,
  remoteAccess: loadRemoteAccessTab,
  relay: loadRelayTab,
};

/** 预热顺序：当前标签自己在加载，排除掉；其余按标签栏顺序逐个排队。 */
export function chunkPreloadOrder(activeTab: SettingsTab): ChunkPreloadTarget[] {
  return SETTINGS_TABS.filter((tab) => tab !== activeTab).map((tab) => TAB_CHUNK_LOADERS[tab]);
}

/** 用 `SiteSettingsForm` 的标签；其余标签下不必拉 `/api/settings/site`。 */
const TABS_USING_SITE_SETTINGS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'general',
  'notifications',
]);

// 标签栏的展示顺序与 SETTINGS_TABS（预热顺序）无关：这里按使用频率排，图标与 i18n key 一并定死。
const SETTINGS_TAB_BAR = [
  { value: 'general', labelKey: 'settings.tabGroup.general', icon: SettingsIcon },
  { value: 'terminal', labelKey: 'settings.tabGroup.terminal', icon: Monitor },
  { value: 'devicesAndFiles', labelKey: 'settings.tabGroup.devicesAndFiles', icon: Server },
  { value: 'remoteAccess', labelKey: 'settings.tabGroup.remoteAccess', icon: Globe },
  { value: 'nodes', labelKey: 'settings.tabGroup.nodes', icon: Network },
  { value: 'notifications', labelKey: 'settings.tabGroup.notifications', icon: Bell },
  { value: 'ai', labelKey: 'settings.tabGroup.ai', icon: Sparkles },
] as const satisfies readonly {
  value: SettingsTab;
  labelKey: string;
  icon: typeof SettingsIcon;
}[];

/** 中继标签只在本机带中继角色时出现，紧挨「多节点互联」右侧：两者说的是同一件事。 */
const RELAY_TAB_ITEM = {
  value: 'relay',
  labelKey: 'relay.admin.tabLabel',
  icon: RadioTower,
} as const satisfies { value: SettingsTab; labelKey: string; icon: typeof SettingsIcon };

type SettingsTabBarItem = (typeof SETTINGS_TAB_BAR)[number] | typeof RELAY_TAB_ITEM;

export function settingsTabBarItems(showRelay: boolean): SettingsTabBarItem[] {
  if (!showRelay) return [...SETTINGS_TAB_BAR];
  const at = SETTINGS_TAB_BAR.findIndex((item) => item.value === 'nodes') + 1;
  return [...SETTINGS_TAB_BAR.slice(0, at), RELAY_TAB_ITEM, ...SETTINGS_TAB_BAR.slice(at)];
}

function isSettingsTab(value: string | null): value is SettingsTab {
  if (value === null) return false;
  return (
    (SETTINGS_TABS as string[]).includes(value) ||
    (OPTIONAL_SETTINGS_TABS as string[]).includes(value)
  );
}

/** `?tab=` 的唯一解释处：缺失或不认识一律回「通用」。 */
export function settingsTabFromParam(value: string | null): SettingsTab {
  return isSettingsTab(value) ? value : 'general';
}

/**
 * 标签条。站点设置的草稿态每敲一键就是一次 set，标签条与它毫无关系：
 * memo 挡在这里，七个 `TabsTrigger`（各带图标与 `t()`）才不会跟着每个字符重渲染。
 */
const SettingsTabBar = memo(function SettingsTabBar({
  activeTab,
  showRelay,
  onSelect,
  onWarm,
}: {
  activeTab: SettingsTab;
  showRelay: boolean;
  onSelect: (tab: SettingsTab) => void;
  onWarm: (tab: SettingsTab) => void;
}) {
  const { t } = useTranslation();
  const items = settingsTabBarItems(showRelay);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 标签条在窄屏下是横向滚动的：深链进来时它停在最左，选中态整个在视口外，
  // 用户看不出自己在哪一页。选中的标签变了就把它滚进来。
  // 中继标签是门禁结论回来之后才挂上的，结论没回来时先不找。
  useEffect(() => {
    if (activeTab === 'relay' && !showRelay) return;
    const trigger = listRef.current?.querySelector<HTMLElement>(
      `[data-testid="settings-tab-${activeTab}"]`
    );
    if (trigger && typeof trigger.scrollIntoView === 'function') {
      trigger.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }, [activeTab, showRelay]);

  return (
    <Tabs value={activeTab} onValueChange={(value) => onSelect(value as SettingsTab)}>
      <TabsList
        ref={listRef}
        className="w-full gap-1 !justify-start overflow-x-auto rounded-xl border border-border/60 p-1.5 group-data-horizontal/tabs:h-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <TabsTrigger
              key={item.value}
              value={item.value}
              data-testid={`settings-tab-${item.value}`}
              // 悬停/触摸即预热：比空闲队列更早，指针到点下之间那点时间足够把 chunk 和数据都拉回来。
              onPointerEnter={() => onWarm(item.value)}
              onTouchStart={() => onWarm(item.value)}
              className={cn(pillTabTriggerClassName, 'min-w-max gap-2 px-3.5')}
            >
              <Icon />
              {t(item.labelKey)}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
});

/**
 * 承载站点设置草稿的那一层：**常挂**（不带 key），切标签不丢未保存的改动，
 * 但只有真正用它的两个标签才去拉站点设置。草稿改动的重渲染就此止步于此，
 * 不再上溯到标签条。
 */
function SettingsTabPanels({ activeTab }: { activeTab: SettingsTab }) {
  const form = useSiteSettingsForm({ enabled: TABS_USING_SITE_SETTINGS.has(activeTab) });

  return (
    // 只让新挂载的面板入场，标签条本身不动（key 换了才重挂，动画才会重放）。
    // 多数标签页返回的是 Fragment，卡片之间的间距原本由外层 gap 提供——包一层就必须
    // 把同样的 gap 补回来，否则卡片会贴在一起。
    <Reveal key={activeTab} className="flex min-w-0 flex-col gap-4 sm:gap-6">
      <Suspense
        fallback={
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
          </div>
        }
      >
        {activeTab === 'general' && <GeneralSettingsTab form={form} />}

        {activeTab === 'devicesAndFiles' && <DevicesAndFilesTab />}

        {activeTab === 'nodes' && <NodesTab />}

        {activeTab === 'notifications' && <NotificationSettingsTab form={form} />}

        {activeTab === 'ai' && <AISettingsTab />}

        {activeTab === 'terminal' && <TerminalSettingsTab />}

        {activeTab === 'remoteAccess' && <RemoteAccessTab />}

        {activeTab === 'relay' && <RelayTab />}
      </Suspense>
    </Reveal>
  );
}

export default function SettingsPage() {
  // `?tab=` 是对外的深链（侧栏「节点」入口与老 /nodes 书签都落到这里）。
  // URL 就是唯一事实来源：另存一份 state 的话，挂载后导航到 `/settings` 或 `?tab=bogus`
  // （query 变了但组件不重挂）就会停在上一个标签，与「非法值回退到通用」的约定不符。
  // 切换标签时用 replace 写回，避免每点一次都往历史里塞一条。
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = settingsTabFromParam(searchParams.get('tab'));
  // 一次性：挂载时按当时的标签算出预热顺序，之后切标签不重排（已发起的 chunk 不会重发）。
  const [preloadOrder] = useState(() => chunkPreloadOrder(activeTab));
  useEffect(() => startIdleChunkPreload(preloadOrder), [preloadOrder]);

  // 数据预取要落到这条路由 node 自己的 QueryClient 上（每个 node 一份），
  // 与 NodeRuntimeBoundary 里那个 provider 取的是同一个实例。
  // 「中继」标签的门禁：进设置页探一次 `/api/relay/status`，404（角色缺席）就不摆这个标签。
  const relayAvailability = useRelayAvailability();

  const routeNodeId = useRouteNodeId();
  const runtime = useOptionalRuntime();
  // 每次进设置页各标签只预取一次：鼠标扫过标签栏不该把请求发好几遍。
  const prefetchedTabs = useRef<Set<string>>(new Set());

  const warmTab = useCallback(
    (tab: SettingsTab) => {
      preloadChunk(TAB_CHUNK_LOADERS[tab]);
      if (!runtime) return;
      prefetchTabData(nodeQueryClient(routeNodeId), tab, runtime.apiClient, prefetchedTabs.current);
    },
    [runtime, routeNodeId]
  );

  const selectTab = useCallback(
    (value: SettingsTab) => {
      setSearchParams(
        (params) => {
          params.set('tab', value);
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:gap-6 sm:p-5"
      data-testid="settings-page"
    >
      <SettingsTabBar
        activeTab={activeTab}
        showRelay={relayAvailability === 'available'}
        onSelect={selectTab}
        onWarm={warmTab}
      />
      <SettingsTabPanels activeTab={activeTab} />
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
