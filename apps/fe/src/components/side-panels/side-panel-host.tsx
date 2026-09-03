// 右侧滑出面板的宿主：读 `?panel=<name>` 决定开哪一个，挂在 RootLayout 的外壳里。
// 两块内容问的都是**本机**（`/api/local/*`、`/api/auth/*` 都不带 `/n/` 前缀），
// 所以用 AppRoot 提供的 entry（self）运行时与 QueryClient 即可，不跟路由 node 走。
//
// 两块内容都按需加载：接入指引是纯静态长文，账号安全原属已删除的 `/account/security` 页，
// 静态引入会把这两坨代码拖进首屏 chunk。走 `lazyChunk` 而不是裸 `lazy`：
// 发版后旧 chunk 404 时先就地重试，重试不回来才落到卡片上。
//
// 面板内容再包一层错误边界（panel 形态）：面板炸了只毁这一块，页面其他部分照常可用，
// 不会像以前那样整片交给 React Router 的默认错误页。
//
// 退场动画由 Base UI 负责——Popup 在 `data-ending-style` 期间保持挂载，动画跑完才卸载。
// 但 `rendered` 不能跟着 `panel` 一起立刻清空，否则内容在退场动画开始前就没了；
// 这里等 `onOpenChangeComplete(false)` 再清。

import { AppErrorBoundary } from '@/components/app-error-boundary';
import { withI18nRest } from '@/i18n/rest-prerequisite';
import { lazyChunk } from '@/lazy-chunk';
import { Button } from '@tmex/ui/button';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@tmex/ui/sheet';
import { Loader2, X } from 'lucide-react';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SidePanelName } from './side-panel-url';
import { useSidePanel } from './use-side-panel';

// 面板 chunk 与 rest 语言包并行加载、两者都到位才挂载：只靠 idle 预取的话，
// 面板 chunk 先到就会把 `connectDevices.*` 这类裸 key 直接渲染出来（见 `@/i18n/rest-prerequisite`）。
export const loadConnectDevicesPanel = withI18nRest(
  async () => (await import('./connect-devices/connect-devices-panel')).default
);
export const loadAccountSecurityPanel = withI18nRest(
  async () => (await import('./account-security-panel')).default
);

const ConnectDevicesPanel = lazyChunk<Record<string, never>>(loadConnectDevicesPanel);
const AccountSecurityPanel = lazyChunk<Record<string, never>>(loadAccountSecurityPanel);

const PANEL_TITLE_KEY = {
  connect: 'nav.connectDevices',
  security: 'auth.security.title',
} as const satisfies Record<SidePanelName, string>;

export function SidePanelHost() {
  const { t } = useTranslation();
  const { panel, close } = useSidePanel();
  // 渲染中的面板：开着时跟随 URL，关闭时留到退场动画结束。
  const [rendered, setRendered] = useState<SidePanelName | null>(panel);
  if (panel && panel !== rendered) setRendered(panel);

  return (
    <Sheet
      open={panel !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) setRendered(null);
      }}
    >
      {rendered ? (
        <SheetContent
          side="right"
          // 默认的 3/4 宽 + sm:max-w-sm 装不下带命令块的分步指引；这里整段覆写（含 data-[side] 前缀，
          // 否则 tailwind-merge 认不出是同一组类，两条 max-width 会同时生效）。
          className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl data-[side=right]:md:max-w-2xl"
          data-testid={`side-panel-${rendered}`}
          // 关闭按钮放进标题行（自带的那个是绝对定位 + 未翻译的 sr-only 文案）。
          showCloseButton={false}
        >
          <SheetHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b border-border">
            <SheetTitle className="min-w-0 truncate">{t(PANEL_TITLE_KEY[rendered])}</SheetTitle>
            <SheetClose
              render={<Button variant="ghost" size="icon-sm" />}
              aria-label={t('common.close')}
              data-testid="side-panel-close"
            >
              <X className="size-4" />
            </SheetClose>
          </SheetHeader>
          {/* min-h-0 + overflow-y-auto：内容（如展开的 TOTP 二维码）超高时在面板内滚，
              不会像原来那页那样被撑出可视区又滚不动。
              bg-muted/50 与页面内容区一致，卡片（bg-background）才有对比。 */}
          <div
            className="bg-muted/50 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-4 pb-[max(1rem,var(--tmex-safe-area-bottom))] [-webkit-overflow-scrolling:touch]"
            data-testid="side-panel-body"
          >
            <SidePanelBody panel={rendered} onClose={close} />
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

/**
 * 面板内容区。抽成独立组件是为了能单测：宿主本体渲染在 Base UI 的 portal 里，
 * 服务端静态渲染取不到任何标记。
 *
 * 边界带 `key={panel}`：换面板等于换内容，上一块的错误不该留给下一块。
 */
export function SidePanelBody({
  panel,
  onClose,
}: {
  panel: SidePanelName;
  onClose: () => void;
}) {
  return (
    <AppErrorBoundary key={panel} variant="panel" onClose={onClose}>
      <Suspense fallback={<PanelPending />}>
        {panel === 'connect' ? <ConnectDevicesPanel /> : <AccountSecurityPanel />}
      </Suspense>
    </AppErrorBoundary>
  );
}

function PanelPending() {
  return (
    <div
      className="flex flex-1 items-center justify-center p-8 text-muted-foreground"
      data-testid="side-panel-pending"
    >
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
    </div>
  );
}
