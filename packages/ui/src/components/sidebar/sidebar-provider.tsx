import * as React from 'react';

import { useIsMobile } from '../../hooks/use-mobile';
import { cn } from '../../utils';
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_KEYBOARD_SHORTCUT,
  SIDEBAR_WIDTH_DEFAULT_PX,
  SIDEBAR_WIDTH_ICON,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from './constants';
import { SidebarContext, type SidebarContextProps } from './context';
import {
  clampSidebarWidth,
  parseStoredSidebarWidth,
  preferredSidebarWidth,
  viewportWidth,
} from './width';

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
  const [openMobile, setOpenMobile] = React.useState(false);

  // preferredWidthRef 保存用户期望宽度（仅受下限约束、不被视口裁剪），
  // 实际展示的 width 再按当前视口 clamp，这样窗口缩小后再放大能恢复原宽度。
  const preferredWidthRef = React.useRef<number>(SIDEBAR_WIDTH_DEFAULT_PX);
  const [width, _setWidth] = React.useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT_PX;
    const preferred = parseStoredSidebarWidth(
      window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    );
    preferredWidthRef.current = preferred;
    return clampSidebarWidth(preferred, viewportWidth());
  });
  const [isResizing, setIsResizing] = React.useState(false);

  const setWidth = React.useCallback((value: number) => {
    const preferred = preferredSidebarWidth(value);
    preferredWidthRef.current = preferred;
    _setWidth(clampSidebarWidth(preferred, viewportWidth()));
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(preferred));
  }, []);

  const resetWidth = React.useCallback(() => {
    preferredWidthRef.current = SIDEBAR_WIDTH_DEFAULT_PX;
    _setWidth(clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT_PX, viewportWidth()));
    window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
  }, []);

  React.useEffect(() => {
    const onResize = () => {
      _setWidth(clampSidebarWidth(preferredWidthRef.current, viewportWidth()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
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

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open]
  );

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
  }, [isMobile, setOpen]);

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
      openMobile,
      setOpenMobile,
      toggleSidebar,
      width,
      setWidth,
      resetWidth,
      isResizing,
      setIsResizing,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      toggleSidebar,
      width,
      setWidth,
      resetWidth,
      isResizing,
    ]
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
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
    </SidebarContext.Provider>
  );
}
