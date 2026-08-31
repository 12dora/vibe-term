import { Brand } from '@/components/brand';
import { useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { IconTooltip } from '@tmex/ui/icon-tooltip';
import { useSidebar } from '@tmex/ui/sidebar';
import { Settings, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from './nav-link';
import { ThemeMenu } from './theme-menu';

/** 顶部动作按钮统一尺寸：最多三个（延迟、主题、设置），必须挤进一行。 */
const ACTION_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground';

export function SidebarTitle() {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();

  // Fetch settings on mount if not loaded
  const fetchSettings = useSiteStore((state) => state.fetchSettings);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

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
        <WsLatency />
        <ThemeMenu />
        <IconTooltip label={t('sidebar.settings')}>
          <NavLink
            to="/settings"
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
