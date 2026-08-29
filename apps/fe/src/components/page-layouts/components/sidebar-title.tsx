import { Brand } from '@/components/brand';
import { useSidePanel } from '@/components/side-panels/use-side-panel';
import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';
import { Network, Settings, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from './nav-link';
import { ThemeMenu } from './theme-menu';

/** 顶部动作按钮统一尺寸：mesh 下最多四个（延迟、主题、节点、设置），必须挤进一行。 */
const ACTION_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground';

export function SidebarTitle() {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();
  const { meshEnabled } = useSharedAuthMode();
  // 「多节点互联」改成右侧滑出面板：不离开当前页面，链接形态保留（可右键新开、可分享）。
  const { hrefFor } = useSidePanel();

  // Fetch settings on mount if not loaded
  const fetchSettings = useSiteStore((state) => state.fetchSettings);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return (
    <div className="flex items-center gap-1 px-2">
      {isMobile && (
        <button
          type="button"
          data-testid="mobile-sidebar-close"
          onClick={() => setOpenMobile(false)}
          className={`${ACTION_BUTTON_CLASS} ml-[-8px]`}
          aria-label={t('nav.closeSidebar')}
          title={t('nav.closeSidebar')}
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <Brand linkTo="/" linkComponent={NavLink} className="flex-1" />
      <div className="flex shrink-0 items-center gap-0.5 mr-[-8px]">
        <WsLatency />
        <ThemeMenu />
        {meshEnabled && (
          <NavLink
            to={hrefFor('nodes')}
            className={ACTION_BUTTON_CLASS}
            data-testid="sidebar-nodes"
            aria-label={t('sidebar.nodes')}
            title={t('sidebar.nodes')}
          >
            <Network className="h-4 w-4" />
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className={ACTION_BUTTON_CLASS}
          data-testid="sidebar-settings"
          aria-label={t('sidebar.settings')}
          title={t('sidebar.settings')}
        >
          <Settings className="h-4 w-4" />
        </NavLink>
      </div>
    </div>
  );
}

function WsLatency() {
  const latency = useTmuxStore((s) => s.wsLatencyMs);
  if (latency === null) return null;

  const isHigh = latency >= 200;
  return (
    <span
      className={`inline-flex h-8 shrink-0 items-center px-0.5 text-xs tabular-nums ${isHigh ? 'text-orange-400' : 'text-muted-foreground'}`}
    >
      {latency}ms
    </span>
  );
}
