import { Brand } from '@/components/brand';
import { settingsPageModule } from '@/page-modules';
import { useSiteStore, useTmuxStore } from '@tmex/stores/react';
import { ICON_TOOLTIP_DELAY_MS, IconTooltip } from '@tmex/ui/icon-tooltip';
import { useSidebar } from '@tmex/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tmex/ui/tooltip';
import { Settings, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from './nav-link';
import { ThemeMenu } from './theme-menu';

// 顶部动作按钮统一尺寸：最多三个（延迟、主题、设置），必须挤进一行。
// 焦点环只给键盘操作：抽屉打开时焦点会被移到这一行的第一个按钮上，`:focus` 的默认描边
// 会在触摸打开后一直挂着。
const ACTION_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

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
            preload={settingsPageModule}
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

/** 气泡文案：原始样本与平滑后的读数一致时不重复说一遍。 */
export interface LatencyTooltipLine {
  key: 'nav.latencyTooltip' | 'nav.latencyTooltipRaw';
  ms?: number;
}

export function latencyTooltipLines(
  latency: number,
  rawLatency: number | null
): LatencyTooltipLine[] {
  const lines: LatencyTooltipLine[] = [{ key: 'nav.latencyTooltip' }];
  if (rawLatency !== null && rawLatency !== latency) {
    lines.push({ key: 'nav.latencyTooltipRaw', ms: rawLatency });
  }
  return lines;
}

function WsLatency() {
  const latency = useTmuxStore((s) => s.wsLatencyMs);
  // wsLatencyRawMs 是后加的字段，老状态里可能还没有。
  const rawLatency = useTmuxStore(
    (s) => (s as { wsLatencyRawMs?: number | null }).wsLatencyRawMs ?? null
  );
  if (latency === null) return null;
  return <LatencyBadge latency={latency} rawLatency={rawLatency} />;
}

// 数字本身说明不了它量的是哪一段链路：气泡讲清楚只到入口节点，且取的是最近几次的中位数。
// 用气泡原语而不是 IconTooltip：后者的 label 只收一个字符串，这里要两行。
export function LatencyBadge({
  latency,
  rawLatency,
}: {
  latency: number;
  rawLatency: number | null;
}) {
  const { t } = useTranslation();
  const isHigh = latency >= 200;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={ICON_TOOLTIP_DELAY_MS}
        render={<span />}
        tabIndex={0}
        data-testid="ws-latency"
        className={`inline-flex h-8 shrink-0 items-center rounded-md px-0.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring ${isHigh ? 'text-orange-400' : 'text-muted-foreground'}`}
      >
        {latency}ms
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72 whitespace-normal">
        {latencyTooltipLines(latency, rawLatency).map((line, index) => (
          <p key={line.key} className={index === 0 ? undefined : 'mt-1 opacity-80'}>
            {t(line.key, { ms: line.ms })}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
