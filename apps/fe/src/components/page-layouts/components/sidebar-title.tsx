import { useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';
import { Settings, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from './nav-link';
import { ThemeMenu } from './theme-menu';

export function SidebarTitle() {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();
  const siteName = useSiteStore((state) => state.settings?.siteName);

  // Fetch settings on mount if not loaded
  const fetchSettings = useSiteStore((state) => state.fetchSettings);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const displayName = siteName ?? 'tmex';

  return (
    <div className="flex items-center gap-2 px-2">
      {isMobile && (
        <button
          type="button"
          data-testid="mobile-sidebar-close"
          onClick={() => setOpenMobile(false)}
          className="inline-flex h-8 w-8 ml-[-8px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          aria-label={t('nav.closeSidebar')}
          title={t('nav.closeSidebar')}
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <NavLink to="/" className="flex flex-1 items-center gap-3 overflow-hidden">
        <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg border-2 border-black">
          <img src="/logo.png" alt={displayName} className="h-full w-full object-cover" />
        </div>
        <span className="truncate text-sm font-semibold tracking-tight">{displayName}</span>
      </NavLink>
      <WsLatency />
      <ThemeMenu />
      <NavLink
        to="/settings"
        className="inline-flex h-8 w-8 mr-[-8px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        aria-label={t('sidebar.settings')}
        title={t('sidebar.settings')}
      >
        <Settings className="h-4 w-4" />
      </NavLink>
    </div>
  );
}

function WsLatency() {
  const latency = useTmuxStore((s) => s.wsLatencyMs);
  if (latency === null) return null;

  const isHigh = latency >= 200;
  return (
    <span
      className={`inline-flex h-8 shrink-0 items-center text-xs tabular-nums ${isHigh ? 'text-orange-400' : 'text-muted-foreground'}`}
    >
      {latency}ms
    </span>
  );
}
