import { Menu, PanelLeftIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../utils';
import { Button } from '../button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../sheet';
import { SIDEBAR_WIDTH_MOBILE } from './constants';
import { useSidebar, useSidebarWidth } from './context';
import { createSidebarResizeController, domResizeFrames } from './resize-controller';
import type { SidebarSide } from './width';

export function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  dir,
  ...props
}: React.ComponentProps<'div'> & {
  side?: SidebarSide;
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}) {
  const { isMobile, state, openMobile, setOpenMobile, mobileInitialFocus, isResizing } =
    useSidebar();

  if (collapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          'bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          dir={dir}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          data-testid="mobile-sidebar-sheet"
          className="bg-sidebar text-sidebar-foreground p-0 [&>button]:hidden border-none"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
              width: SIDEBAR_WIDTH_MOBILE,
              maxWidth: SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
          animation="top-down"
          initialFocus={mobileInitialFocus}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div
            className="flex h-full w-full flex-col"
            data-testid="sidebar"
            style={{ paddingBottom: 'var(--tmex-safe-area-bottom)' }}
          >
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer text-sidebar-foreground hidden md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          !isResizing &&
            'transition-[width] duration-(--tmex-motion-layout) ease-out motion-reduce:transition-none',
          'relative w-(--sidebar-width) bg-transparent',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)'
        )}
      />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          !isResizing &&
            'transition-[left,right,width] duration-(--tmex-motion-layout) ease-out motion-reduce:transition-none',
          'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] md:flex',
          // Adjust the padding for floating and inset variants.
          variant === 'floating' || variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          data-testid="sidebar"
          className="bg-sidebar group-data-[variant=floating]:ring-sidebar-border group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1 flex size-full flex-col"
          style={{ paddingBottom: 'var(--tmex-safe-area-bottom)' }}
        >
          {children}
        </div>
        {state === 'expanded' && <SidebarResizer side={side} />}
      </div>
    </div>
  );
}

export function SidebarResizer({ side }: { side: SidebarSide }) {
  const { width, setWidth, commitWidth, resetWidth } = useSidebarWidth();
  const { setIsResizing } = useSidebar();

  // 三个回调都是 provider 里恒等的 useCallback / setState，所以控制器实际只建一次
  const controller = React.useMemo(
    () =>
      createSidebarResizeController({
        setWidth,
        commitWidth,
        setResizing: setIsResizing,
        ...domResizeFrames,
      }),
    [setWidth, commitWidth, setIsResizing]
  );

  React.useEffect(() => () => controller.dispose(), [controller]);

  return (
    <div
      data-slot="sidebar-resizer"
      data-testid="sidebar-resizer"
      aria-hidden="true"
      className={cn(
        'absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none select-none',
        'after:absolute after:inset-y-0 after:w-[2px] after:bg-transparent hover:after:bg-sidebar-border active:after:bg-sidebar-border',
        side === 'left' ? '-right-1 after:right-[3px]' : '-left-1 after:left-[3px]'
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        controller.start(event.pointerId, event.clientX, width);
      }}
      onPointerMove={(event) => controller.move(event.pointerId, event.clientX, side)}
      onPointerUp={(event) => controller.end(event.pointerId)}
      onPointerCancel={(event) => controller.end(event.pointerId)}
      onDoubleClick={resetWidth}
    />
  );
}

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar, isMobile } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      {isMobile ? <Menu /> : <PanelLeftIcon />}
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

export function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        'hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 transition-all duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2',
        'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        className
      )}
      {...props}
    />
  );
}

export function SidebarInset({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        'bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2 relative flex w-full flex-1 flex-col',
        className
      )}
      {...props}
    />
  );
}
