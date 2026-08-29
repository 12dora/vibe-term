// 路由页外框：顶栏（品牌 / 侧栏开关 + 页标题 + 页动作）与页面模块的按需加载。
// withSidebar=false：/login 挂在 RootLayout（SidebarProvider）之外，
// 不能渲染 SidebarTrigger，改在顶栏左侧展示品牌。

import { PageLoadFallback } from '@/PageLoadFallback';
import { Brand } from '@/components/brand';
import { type PageModuleLoader, usePageModule } from '@/use-page-module';
import { cn } from '@tmex/ui';
import { Separator } from '@tmex/ui/separator';
import { SidebarTrigger } from '@tmex/ui/sidebar';
import { useParams } from 'react-router';

export function PageWrapper({
  moduleLoader,
  withSidebar = true,
  animateContent = true,
}: {
  moduleLoader: PageModuleLoader;
  withSidebar?: boolean;
  /**
   * 页面模块就位时给内容区一次淡入上移。终端页必须关掉：入场期间的 transform
   * 会成为 fixed 后代的 containing block，并可能扰动 xterm 的几何测量。
   */
  animateContent?: boolean;
}) {
  const { state, retry } = usePageModule(moduleLoader);
  const params = useParams();

  const module = state.status === 'ready' ? state.module : null;
  const Page = module?.default;
  const PageTitle = module?.PageTitle;
  const PageActions = module?.PageActions;

  return (
    <>
      <header
        className="sticky top-0 z-10 flex h-12 md:h-16 shrink-0 items-center justify-between gap-2 bg-background/95 backdrop-blur-sm"
        data-testid="mobile-topbar"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          {withSidebar ? (
            <SidebarTrigger className="-ml-1 shrink-0" data-testid="mobile-sidebar-open" />
          ) : (
            <Brand size="sm" linkTo="/" />
          )}
          <Separator
            orientation="vertical"
            className="mr-2 shrink-0 data-[orientation=vertical]:h-4"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {PageTitle ? <PageTitle {...params} /> : ''}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 px-4">
          {PageActions && <PageActions {...params} />}
        </div>
      </header>

      {/* Page content */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 !pt-0 p-2 md:p-4">
        <div
          // key 让 loading→ready 时容器重挂一次，动画才落在真正有内容的那一帧上。
          key={animateContent ? state.status : undefined}
          className={cn(
            'bg-muted/50 min-h-0 flex-1 overflow-auto overscroll-auto rounded-xl [-webkit-overflow-scrolling:touch]',
            animateContent && 'tmex-reveal'
          )}
        >
          {state.status === 'error' ? <PageLoadFallback onRetry={retry} /> : Page ? <Page /> : null}
        </div>
      </div>
    </>
  );
}
