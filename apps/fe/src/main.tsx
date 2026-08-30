import { QueryClientProvider } from '@tanstack/react-query';
import { PRODUCT_NAME, formatDisplayVersion } from '@tmex/shared';
import { type CSSProperties, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, RouterProvider, createBrowserRouter } from 'react-router';
import { Toaster } from 'sonner';
import { i18nReady } from './i18n';
import './index.css';

// 浏览器 console 打印 monorepo 版本（非 production 带 _dev 后缀）
console.info(`${PRODUCT_NAME} ${formatDisplayVersion(__MONOREPO_VERSION__, __IS_PROD__)}`);

import { isAuthTransitionActive } from '@/auth/auth-transition';
import { FlowBridges } from '@/components/flow-bridges';
import { AppSidebar } from '@/components/page-layouts/components/app-sidebar';
import { SidePanelHost } from '@/components/side-panels/side-panel-host';
import { useAppMonoFont } from '@/lib/fonts/useAppMonoFont';
import { MeshNodesResident } from '@/node/mesh-nodes-resident';
import { NodeRouteGate, NodeRuntimeBoundary, useRouteNodeId } from '@/node/node-runtime-boundary';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { appNodeRuntimes, nodeQueryClient } from '@/node/node-runtimes';
import { PageWrapper } from '@/page-wrapper';
import { installSessionInterceptor } from '@tmex/api-client/auth/index';
import { ConnectionIndicator } from '@tmex/panels';
import { SettingsEventsInit } from '@tmex/panels/settings/events';
import { WatchEventsInit } from '@tmex/panels/watch';
import { SELF_NODE_ID, useNodeRuntime } from '@tmex/stores';
import { RuntimeProvider, useSiteStore, useUIStore } from '@tmex/stores/react';
import { useKeyboardAvoidance } from '@tmex/terminal-ui/hooks/use-keyboard-avoidance';
import { applyThemePreset, isThemePreset } from '@tmex/theme';
import { SidebarInset, SidebarProvider, useSidebar } from '@tmex/ui/sidebar';

function applyInitialTheme(): void {
  try {
    const raw = localStorage.getItem('tmex-ui');
    if (!raw) {
      document.documentElement.classList.add('dark');
      return;
    }

    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } } | null;
    const theme = parsed?.state?.theme;
    const isDark = theme === 'dark' || theme === undefined;
    document.documentElement.classList.toggle('dark', isDark);
  } catch {
    document.documentElement.classList.add('dark');
  }
}

applyInitialTheme();

// 主题预设（dormant preset 激活机制）：初始从持久化状态应用，变更时跟随。
// UI 偏好是宿主级的（所有 node 共用一个 UIStore，key 仍为 tmex-ui），因此这里直接读裸 key。
function applyInitialThemePreset(): void {
  try {
    const raw = localStorage.getItem('tmex-ui');
    const parsed = raw ? (JSON.parse(raw) as { state?: { themePreset?: unknown } }) : null;
    const preset = parsed?.state?.themePreset;
    applyThemePreset(isThemePreset(preset) ? preset : null);
  } catch {
    applyThemePreset(null);
  }
}

applyInitialThemePreset();

// 主题预设跟随共享 UI store（原先是模块级 useUIStore.subscribe，绑死默认 runtime）。
function ThemePresetSync() {
  const themePreset = useUIStore((state) => state.themePreset);
  useEffect(() => {
    applyThemePreset(themePreset);
  }, [themePreset]);
  return null;
}

// iOS 26+ standalone: Safari 从 body 背景色推导状态栏颜色。
// Android Chrome: 从 <meta name="theme-color"> 读取，支持运行时动态修改。
// 侧边栏（mobile Sheet）展开时切到 --sidebar，关闭时回到 --background。
function StatusBarSync() {
  const { openMobile } = useSidebar();
  const theme = useUIStore((state) => state.theme);
  // 预设主题会改写 --background/--sidebar，故 themePreset 变化也要重算状态栏颜色
  const themePreset = useUIStore((state) => state.themePreset);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme/themePreset 改写 CSS 变量，虽未在 effect 内引用，但其变化必须触发状态栏颜色重算
  useEffect(() => {
    const cssVar = openMobile ? '--sidebar' : '--background';
    document.body.style.backgroundColor = `var(${cssVar})`;

    const updateMeta = () => {
      const computed = getComputedStyle(document.body).backgroundColor;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', computed);
    };

    requestAnimationFrame(updateMeta);
  }, [openMobile, theme, themePreset]);

  return null;
}

// Toaster 跟随 app 主题（默认未设 theme 时 sonner 固定浅色，暗色模式下卡片会是白底）。
function ThemedToaster() {
  const theme = useUIStore((state) => state.theme);
  return (
    <Toaster
      theme={theme}
      richColors
      position="top-right"
      closeButton
      offset={{
        top: 'calc(16px + env(safe-area-inset-top, 0px))',
        right: '16px',
        bottom: '16px',
        left: '16px',
      }}
      mobileOffset={{
        top: 'calc(12px + env(safe-area-inset-top, 0px))',
        right: '12px',
        bottom: '12px',
        left: '12px',
      }}
      toastOptions={{
        duration: 6000,
      }}
    />
  );
}

// Root layout: 跨 node 常驻的外壳（sidebar + 内容区）。
// 外壳挂在 entry（self）运行时下**永不重挂**：切 node 只换页面区的运行时（见 MainInset），
// 侧边栏保持挂载，只有高亮跟着路由变。
function RootLayout() {
  // 把选中等宽字体派生到 --font-mono（全应用统一）并按需懒加载 woff2
  useAppMonoFont();
  // 桌面端展开/折叠受控于持久化的 ui store，刷新后保留，且 setSidebarCollapsed 能真正开合侧栏
  // （UI 偏好是宿主级的，所有 node 共用一份，读 entry 运行时的即可）
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((state) => state.setSidebarCollapsed);
  return (
    <>
      <SidebarProvider open={!sidebarCollapsed} onOpenChange={(open) => setSidebarCollapsed(!open)}>
        <StatusBarSync />
        <FlowBridges />
        <MeshNodesResident />
        <NodeRuntimeScope nodeId={SELF_NODE_ID}>
          <AppSidebar />
          <SelfSettingsEventsInit />
        </NodeRuntimeScope>
        <MainInset />
        <SidePanelHost />
      </SidebarProvider>
      <RouteConnectionIndicator />
    </>
  );
}

// 连接指示器跟着**路由 node** 走，但必须留在 SidebarInset 外面：键盘避让会给 SidebarInset
// 加 transform，那会让 fixed 定位的指示器改以它为包含块，跑到屏幕里侧去。
// 只注入 runtime，不带 QueryClient / GlobalDeviceProvider——指示器只读 tmux 连接状态。
function RouteConnectionIndicator() {
  const runtime = useNodeRuntime(useRouteNodeId(), appNodeRuntimes);
  return (
    <RuntimeProvider runtime={runtime}>
      <ConnectionIndicator />
    </RuntimeProvider>
  );
}

// 浏览远端 node 时，页面区的设置事件订阅跟着路由 node 走，但设备分组布局等 self 数据
// （固定打 self 的 QueryClient）仍要吃到本机网关的失效事件，否则会拿陈旧布局覆盖新布局。
// 路由就是 self 时页面区已经订阅了，这里不再重复。
function SelfSettingsEventsInit() {
  const routeNodeId = useRouteNodeId();
  return routeNodeId === SELF_NODE_ID ? null : <SettingsEventsInit />;
}

// 路由 node 就绪后才做的接线：事件订阅会开该 node 的 WS，能力集是该 node 的请求，
// 都必须等懒登录门闸放行（`NodeRouteGate` 内部），否则进未登录的 node 会整片 401。
function NodeSessionInit() {
  // 启动即拉取服务端能力集（/api/capabilities），落 site store 供按 featureset 渲染
  const loadCapabilities = useSiteStore((state) => state.loadCapabilities);
  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);
  return (
    <>
      <WatchEventsInit />
      <SettingsEventsInit />
    </>
  );
}

// SidebarInset（<main>）+ 手机虚拟键盘避让（issue #27）。必须在 SidebarProvider 内部
// 才能读取 openMobile：移动端侧边栏 Sheet 打开时终端不可见，此时禁用避让可防止 portal
// 焦点切换导致的 viewport 事件竞态、transform 卡在非零值。
// 避让策略由用户在「键盘行为」设置中选择（keyboardBehaviorMode）：
//   transform=整页上移（页面平移 lift / 光标对齐 follow），不参与布局、不触发终端
//     ResizeObserver；strategy 为 none 时必须移除 transform，否则非 none transform 会成为
//     fixed 后代的 containing block，破坏 iOS editor dock 定位。
//   height=终端缩放（resize），主动收缩可用高度触发终端 ResizeObserver → tmux resize。
function MainInset() {
  const { openMobile } = useSidebar();
  const mode = useUIStore((state) => state.keyboardBehaviorMode);
  const avoidance = useKeyboardAvoidance(openMobile, mode);

  const active = avoidance.strategy !== 'none';
  const style: CSSProperties | undefined =
    avoidance.strategy === 'transform'
      ? {
          transform: `translateY(-${avoidance.offset}px)`,
          // 光标对齐逐帧跟随光标，去掉过渡以即时响应输入；其余模式用平滑过渡
          transition: mode === 'follow' ? undefined : 'transform 0.12s ease-out',
        }
      : avoidance.strategy === 'height'
        ? { height: `${avoidance.height}px`, transition: 'height 0.12s ease-out' }
        : undefined;

  return (
    <SidebarInset className="h-dvh overflow-hidden md:h-[calc(100dvh-1rem)]" style={style}>
      {/* 页面区才按路由 node 换运行时：换 runtime 实例会重挂整棵子树，外壳必须留在外面 */}
      <NodeRuntimeBoundary>
        <NodeRouteGate>
          <NodeSessionInit />
          <Outlet />
        </NodeRouteGate>
      </NodeRuntimeBoundary>
      <div
        style={{
          height: active ? 0 : 'var(--tmex-safe-area-bottom)',
          transition: 'height 0.12s ease-out',
        }}
      />
    </SidebarInset>
  );
}

// Lazy load page modules
const settingsModule = () => import('./pages/SettingsPage');
const devicesModule = () => import('./pages/DevicesPage');
const deviceModule = () => import('./pages/DevicePage');
const fileModule = () => import('./pages/FilePage');
const loginModule = () => import('./pages/LoginPage');

// 页面路由在 `self`（旧路由）与 `/n/:nodeId` 两处各挂一份；路由对象不可共享，逐次新建。
// 两份都是**同一棵** RootLayout 路由的子级：外壳的元素身份必须跨 node 保持不变，
// 分成两棵顶层路由的话 React Router 会在切换分支时把外壳整个卸载重建（侧边栏闪烁）。
function pageRoutes() {
  return [
    {
      index: true,
      element: <PageWrapper moduleLoader={devicesModule} />,
    },
    {
      path: 'devices',
      element: <PageWrapper moduleLoader={devicesModule} />,
    },
    // 终端页不做内容入场动画：入场 transform 会成为 xterm 里 fixed 后代的 containing
    // block，且会扰动终端首帧的几何测量。
    {
      path: 'devices/:deviceId',
      element: <PageWrapper moduleLoader={deviceModule} animateContent={false} />,
    },
    {
      path: 'devices/:deviceId/windows/:windowId/panes/:paneId',
      element: <PageWrapper moduleLoader={deviceModule} animateContent={false} />,
    },
    {
      path: 'settings',
      element: <PageWrapper moduleLoader={settingsModule} />,
    },
    {
      path: 'file/:ref',
      element: <PageWrapper moduleLoader={fileModule} />,
    },
  ];
}

// 路由配置 - Data 模式：/n/:nodeId/... 为显式 node，旧路由等价于 self（不做重定向）
const router = createBrowserRouter([
  { path: '/login', element: <PageWrapper moduleLoader={loginModule} withSidebar={false} /> },
  // 独立的 /nodes、/account/security 两页已并入设置页与右侧滑出面板；老书签重定向过去，
  // 不要变成 404。
  { path: '/nodes', element: <Navigate to="/settings?tab=nodes" replace /> },
  { path: '/account/security', element: <Navigate to="/settings?panel=security" replace /> },
  {
    path: '/',
    Component: RootLayout,
    children: [...pageRoutes(), { path: 'n/:nodeId', children: pageRoutes() }],
  },
]);

// 退出 mesh 期间本机会话会被主动清空，随之而来的自身 401 是预期内的：
// 这时跳 /login 会把还在等网关重启的编排一起卸载掉，直接压住即可。
installSessionInterceptor({
  navigate: (to) => {
    if (isAuthTransitionActive()) return;
    void router.navigate(to);
  },
});

// 宿主根：entry（self）运行时常驻，供路由之外的外壳组件（Toaster 等）消费。
function AppRoot() {
  const selfRuntime = useNodeRuntime(SELF_NODE_ID, appNodeRuntimes);
  return (
    <RuntimeProvider runtime={selfRuntime}>
      <QueryClientProvider client={nodeQueryClient(SELF_NODE_ID)}>
        <ThemePresetSync />
        <RouterProvider router={router} />
        <ThemedToaster />
      </QueryClientProvider>
    </RuntimeProvider>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

// 当前语言（及 fallback）按需异步加载，渲染前 await 以避免首屏出现未翻译的 key。
// 弱网下即便 locale chunk 加载失败也必须渲染（catch 兜底），否则整页空白比未翻译更糟。
void i18nReady
  .catch(() => undefined)
  .then(() => {
    createRoot(rootElement).render(
      <StrictMode>
        <AppRoot />
      </StrictMode>
    );
  });
