import { Brand } from '@/components/brand';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { nodeQueryClient } from '@/node/node-runtimes';
import { settingsPageModule } from '@/page-modules';
import { prefetchSettingsLanding } from '@/pages/settings/data-prefetch';
import { useOptionalRuntime, useSiteStore } from '@vibeterm/stores/react';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { useSidebar } from '@vibeterm/ui/sidebar';
import { Settings, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from './nav-link';
import { ThemeMenu } from './theme-menu';

// 顶部动作按钮统一尺寸：最多三个（关闭侧栏、主题、设置），必须挤进一行。
// 焦点环只给键盘操作：抽屉打开时焦点会被移到这一行的第一个按钮上，`:focus` 的默认描边
// 会在触摸打开后一直挂着。
const ACTION_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function SidebarTitle() {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeNodeId = useRouteNodeId();
  const runtime = useOptionalRuntime();
  const prefetchedTabs = useRef(new Set<string>());

  // Fetch settings on mount if not loaded
  const fetchSettings = useSiteStore((state) => state.fetchSettings);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const warmSettings = () => {
    if (!runtime) return;
    prefetchSettingsLanding(
      nodeQueryClient(routeNodeId),
      runtime.apiClient,
      prefetchedTabs.current,
      routeNodeId
    );
  };

  return (
    <div className="flex items-center gap-1 px-2">
      {isMobile && (
        <IconTooltip label={t('nav.closeSidebar')} className="ml-[-8px]">
          <button
            type="button"
            data-testid="mobile-sidebar-close"
            onClick={() => setOpenMobile(false)}
            className={ACTION_BUTTON_CLASS}
            aria-label={t('nav.closeSidebar')}
          >
            <X className="h-4 w-4" />
          </button>
        </IconTooltip>
      )}
      <Brand linkTo="/" linkComponent={NavLink} className="flex-1" />
      <div className="flex shrink-0 items-center gap-0.5 mr-[-8px]">
        <ThemeMenu />
        <IconTooltip label={t('sidebar.settings')}>
          <NavLink
            to="/settings"
            preload={settingsPageModule}
            onPointerEnter={warmSettings}
            onTouchStart={warmSettings}
            className={ACTION_BUTTON_CLASS}
            data-testid="sidebar-settings"
            aria-label={t('sidebar.settings')}
          >
            <Settings className="h-4 w-4" />
          </NavLink>
        </IconTooltip>
      </div>
    </div>
  );
}
