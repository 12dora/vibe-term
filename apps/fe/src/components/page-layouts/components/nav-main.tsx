import type { ChunkPreloadTarget } from '@/lib/chunk-preload';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@tmex/ui/sidebar';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { NavLink } from './nav-link';

/**
 * 去掉 `/n/:nodeId` 前缀、query/hash 与结尾斜杠，把 NavLink 生成的宿主感知路径
 * 与地址栏的 pathname 归一到同一形状再比。
 */
export function normalizeNavPath(value: string): string {
  const [path = ''] = value.split(/[?#]/);
  const withoutNodePrefix = path.replace(/^\/n\/[^/]+(?=\/|$)/, '');
  const trimmed = withoutNodePrefix.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * 只认「就是这一页」：`/devices/:deviceId/...` 是终端页，不该把「管理设备」点亮；
 * 现有导航项都不是 section 根，没有前缀匹配的需求。
 */
export function isPathActive(pathname: string, url: string): boolean {
  return normalizeNavPath(pathname) === normalizeNavPath(url);
}

export interface NavMainItem {
  title: string;
  /** 底部并排放不下完整标题时用的短标签；气泡与 aria-label 仍用完整标题。 */
  shortTitle?: string;
  url: string;
  icon: LucideIcon;
  /** 面板入口这类只带查询串的目标（`?panel=…`）走这里带上 history state 与测试锚点。 */
  testId?: string;
  linkState?: unknown;
  /** 指向懒加载路由页时带上它的模块 loader，悬停即预热该 chunk。 */
  preload?: ChunkPreloadTarget;
  items?: {
    title: string;
    url: string;
  }[];
}

export function NavMain({ items }: { items: NavMainItem[] }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <SidebarGroup className="px-2 py-0">
      {/* 底部两个入口并排；折叠成图标条时没有并排的宽度，改回竖排。
          gap-1 在并排态是左右间距，不占垂直空间，保持不动。 */}
      <SidebarMenu className="flex-row gap-1 group-data-[collapsible=icon]:flex-col">
        {items.map((item) => {
          const active =
            item.url.startsWith('/') &&
            (isPathActive(pathname, item.url) ||
              Boolean(item.items?.some((subItem) => isPathActive(pathname, subItem.url))));
          return (
            <Collapsible
              key={item.title}
              defaultOpen={active}
              render={<SidebarMenuItem className="min-w-0 flex-1" />}
            >
              <SidebarMenuButton
                isActive={active}
                size="sm"
                tooltip={t(item.title)}
                aria-label={t(item.title)}
                // 两个入口并排时只有半宽，字号收一档才放得下英文标签。
                className="justify-center gap-1.5 px-1.5 py-1 text-xs"
                data-testid={item.testId}
                render={<NavLink to={item.url} state={item.linkState} preload={item.preload} />}
              >
                <item.icon />
                <span>{t(item.shortTitle ?? item.title)}</span>
              </SidebarMenuButton>
              {item.items?.length ? (
                <>
                  <CollapsibleTrigger
                    render={
                      // Base UI 的 CollapsibleTrigger 挂的是 data-panel-open；旧的
                      // data-[state=open] 选择器留着不碍事，两者都命中同一条旋转。
                      <SidebarMenuAction className="transition-[opacity,transform] data-[state=open]:rotate-90 data-panel-open:rotate-90" />
                    }
                  >
                    <ChevronRight />
                    <span className="sr-only">{t('nav.toggleSubmenu')}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.items?.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton
                            isActive={isPathActive(pathname, subItem.url)}
                            render={<NavLink to={subItem.url} />}
                          >
                            <span>{t(subItem.title)}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </>
              ) : null}
            </Collapsible>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
