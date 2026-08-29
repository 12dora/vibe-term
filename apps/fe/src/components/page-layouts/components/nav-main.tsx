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

export function NavMain({
  items,
}: {
  items: {
    title: string;
    url: string;
    icon: LucideIcon;
    items?: {
      title: string;
      url: string;
    }[];
  }[];
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => {
          const active =
            isPathActive(pathname, item.url) ||
            Boolean(item.items?.some((subItem) => isPathActive(pathname, subItem.url)));
          return (
            <Collapsible key={item.title} defaultOpen={active} render={<SidebarMenuItem />}>
              <SidebarMenuButton
                isActive={active}
                tooltip={t(item.title)}
                render={<NavLink to={item.url} />}
              >
                <item.icon />
                <span>{t(item.title)}</span>
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
                    <span className="sr-only">Toggle</span>
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
