import * as React from 'react';

import { useIsMobile } from '../../hooks/use-mobile';
import { cn } from '../../utils';
import {
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_WIDTH_DEFAULT_PX,
  SIDEBAR_WIDTH_ICON,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from './constants';
import {
  SidebarContext,
  type SidebarContextProps,
  SidebarWidthContext,
  type SidebarWidthContextProps,
} from './context';
import {
  CLOSED_MOBILE_SIDEBAR,
  type MobileSidebarState,
  autoOpenMobileSidebar,
  mobileSheetInitialFocus,
  setMobileSidebarOpen,
} from './mobile-open';
import { readSidebarStorage, removeSidebarStorage, writeSidebarStorage } from './storage';
import {
  clampSidebarWidth,
  parseStoredSidebarWidth,
  preferredSidebarWidth,
  viewportWidth,
} from './width';

/**
 * 侧栏宽度这一份状态。
 *
 * preferredWidthRef 保存用户期望宽度（仅受下限约束、不被视口裁剪），实际展示的 width 再按当前
 * 视口 clamp，这样窗口缩小后再放大能恢复原宽度；视口宽度自身缓存在 ref 里，只随 resize 刷新，
 * 免得拖拽期间每帧读 window.innerWidth（刚写过样式，读一次就是一次强制同步布局）。
 * 落盘只在 commitWidth（拖拽结束）时发生。
 */
function useSidebarWidthState(): SidebarWidthContextProps {
  const preferredWidthRef = React.useRef<number>(SIDEBAR_WIDTH_DEFAULT_PX);
  const viewportWidthRef = React.useRef<number>(Number.POSITIVE_INFINITY);
  const [width, setWidthState] = React.useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT_PX;
    const preferred = parseStoredSidebarWidth(readSidebarStorage(SIDEBAR_WIDTH_STORAGE_KEY));
    preferredWidthRef.current = preferred;
    viewportWidthRef.current = viewportWidth();
    return clampSidebarWidth(preferred, viewportWidthRef.current);
  });

  const setWidth = React.useCallback((value: number) => {
    const preferred = preferredSidebarWidth(value);
    preferredWidthRef.current = preferred;
    setWidthState(clampSidebarWidth(preferred, viewportWidthRef.current));
  }, []);

  const commitWidth = React.useCallback(() => {
    writeSidebarStorage(SIDEBAR_WIDTH_STORAGE_KEY, String(preferredWidthRef.current));
  }, []);

  const resetWidth = React.useCallback(() => {
    preferredWidthRef.current = SIDEBAR_WIDTH_DEFAULT_PX;
    setWidthState(clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT_PX, viewportWidthRef.current));
    removeSidebarStorage(SIDEBAR_WIDTH_STORAGE_KEY);
  }, []);

  React.useEffect(() => {
    const onResize = () => {
      viewportWidthRef.current = viewportWidth();
      setWidthState(clampSidebarWidth(preferredWidthRef.current, viewportWidthRef.current));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return React.useMemo(
    () => ({ width, setWidth, commitWidth, resetWidth }),
    [width, setWidth, commitWidth, resetWidth]
  );
}

/**
 * 移动端抽屉这一份状态。除了开关，还记着「这次是替用户自动弹出的」——那一次不该移动焦点，
 * 否则 PWA 冷启动后焦点落在抽屉里的「关闭侧边栏」上，左上角一直挂着一圈焦点环。
 */
function useMobileSidebarState() {
  const [mobile, setMobile] = React.useState<MobileSidebarState>(CLOSED_MOBILE_SIDEBAR);

  const setOpenMobile = React.useCallback((value: boolean | ((open: boolean) => boolean)) => {
    setMobile((current) =>
      setMobileSidebarOpen(current, typeof value === 'function' ? value(current.open) : value)
    );
  }, []);

  const openMobileWithoutFocus = React.useCallback(() => setMobile(autoOpenMobileSidebar), []);

  return React.useMemo(
    () => ({
      openMobile: mobile.open,
      setOpenMobile,
      openMobileWithoutFocus,
      mobileInitialFocus: mobileSheetInitialFocus(mobile),
    }),
    [mobile, setOpenMobile, openMobileWithoutFocus]
  );
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const mobile = useMobileSidebarState();

  const widthContextValue = useSidebarWidthState();
  const width = widthContextValue.width;
  const [isResizing, setIsResizing] = React.useState(false);

  // 桌面端展开状态：受控时以 openProp 为准（持久化交给调用方），否则退回内部 state。
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }
    },
    [setOpenProp, open]
  );

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? mobile.setOpenMobile((open) => !open) : setOpen((open) => !open);
  }, [isMobile, setOpen, mobile.setOpenMobile]);

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      // 终端聚焦时按键（含 tmux 前缀 Ctrl+B）归终端，不触发侧栏快捷键
      if (event.target instanceof HTMLElement && event.target.closest('.xterm')) {
        return;
      }
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      ...mobile,
      toggleSidebar,
      isResizing,
      setIsResizing,
    }),
    [state, open, setOpen, isMobile, mobile, toggleSidebar, isResizing]
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <SidebarWidthContext.Provider value={widthContextValue}>
        <div
          data-slot="sidebar-wrapper"
          data-resizing={isResizing ? 'true' : undefined}
          style={
            {
              '--sidebar-width': `${width}px`,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn(
            'group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full',
            className
          )}
          {...props}
        >
          {children}
        </div>
      </SidebarWidthContext.Provider>
    </SidebarContext.Provider>
  );
}
