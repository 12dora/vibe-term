import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from './utils';

export type TooltipOpenState = { open: boolean; sticky: boolean };

export type TooltipEvent = 'pointerenter' | 'pointerleave' | 'focus' | 'blur' | 'click' | 'escape';

/** 反相表面（浅色主题暗底 / 深色主题浅底）上的警示与错误字色。 */
export const TOOLTIP_TONE_CLASS = {
  warn: 'text-amber-300 dark:text-amber-700',
  blocked: 'text-red-300 dark:text-red-700',
} as const;

/** hover/focus 打开；click 钉住或取消；Escape 关闭。钉住期间移出不关。 */
export function applyTooltipEvent(state: TooltipOpenState, event: TooltipEvent): TooltipOpenState {
  switch (event) {
    case 'pointerenter':
    case 'focus':
      return { open: true, sticky: state.sticky };
    case 'pointerleave':
    case 'blur':
      return state.sticky ? state : { open: false, sticky: false };
    case 'click':
      return state.sticky ? { open: false, sticky: false } : { open: true, sticky: true };
    case 'escape':
      return { open: false, sticky: false };
  }
}

export type TooltipRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

export type TooltipSize = { width: number; height: number };

export type TooltipPlacement = {
  top: number;
  left: number;
  side: 'top' | 'bottom';
};

const VIEWPORT_MARGIN = 8;
const TOOLTIP_GAP = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pickTooltipSide(input: {
  preferred: 'top' | 'bottom';
  fitsBelow: boolean;
  fitsAbove: boolean;
  spaceBelow: number;
  spaceAbove: number;
}): 'top' | 'bottom' {
  const { preferred, fitsBelow, fitsAbove, spaceBelow, spaceAbove } = input;
  if (preferred === 'bottom') {
    if (fitsBelow) return 'bottom';
    if (fitsAbove) return 'top';
  } else {
    if (fitsAbove) return 'top';
    if (fitsBelow) return 'bottom';
  }
  return spaceAbove > spaceBelow ? 'top' : 'bottom';
}

/** 相对触发器放置面板：垂直翻转、水平夹进视口，边距默认 8px。 */
export function placeTooltipPanel(input: {
  trigger: TooltipRect;
  panel: TooltipSize;
  preferred: 'top' | 'bottom';
  viewport: TooltipSize;
  margin?: number;
  gap?: number;
}): TooltipPlacement {
  const margin = input.margin ?? VIEWPORT_MARGIN;
  const gap = input.gap ?? TOOLTIP_GAP;
  const { trigger, panel, viewport, preferred } = input;
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panel.height;
  const side = pickTooltipSide({
    preferred,
    fitsBelow: below + panel.height <= viewport.height - margin,
    fitsAbove: above >= margin,
    spaceBelow: viewport.height - margin - below,
    spaceAbove: trigger.top - gap - margin,
  });
  const unclampedTop = side === 'bottom' ? below : above;
  const maxTop = Math.max(margin, viewport.height - panel.height - margin);
  const maxLeft = Math.max(margin, viewport.width - panel.width - margin);
  const centered = trigger.left + trigger.width / 2 - panel.width / 2;
  return {
    top: clamp(unclampedTop, margin, maxTop),
    left: clamp(centered, margin, maxLeft),
    side,
  };
}

type TriggerProps = {
  onClick?: (event: { stopPropagation: () => void }) => void;
  onFocus?: (event: unknown) => void;
  onBlur?: (event: unknown) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

export interface TooltipProps {
  children: ReactElement<TriggerProps>;
  content: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom';
  contentProps?: HTMLAttributes<HTMLSpanElement>;
}

function useTooltipOpen(
  openProp: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange?: (open: boolean) => void
) {
  const [uncontrolled, setUncontrolled] = useState<TooltipOpenState>({
    open: defaultOpen,
    sticky: defaultOpen,
  });
  const open = openProp ?? uncontrolled.open;
  const dispatch = (event: TooltipEvent) => {
    const next = applyTooltipEvent({ open, sticky: uncontrolled.sticky }, event);
    setUncontrolled(next);
    if (next.open !== open) onOpenChange?.(next.open);
  };
  return { open, dispatch, setUncontrolled };
}

function nodeInside(node: Node | null, ...els: Array<HTMLElement | null>): boolean {
  return Boolean(node && els.some((el) => el?.contains(node)));
}

function useTooltipDismiss(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  onOpenChange?: (open: boolean) => void,
  setUncontrolled?: (next: TooltipOpenState) => void
) {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const close = () => {
      setUncontrolled?.({ open: false, sticky: false });
      onOpenChange?.(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (nodeInside(event.target as Node, rootRef.current, panelRef.current)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onOpenChange, rootRef, panelRef, setUncontrolled]);
}

function useTooltipPlacement(
  open: boolean,
  preferred: 'top' | 'bottom',
  rootRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>
) {
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const [trigger, setTrigger] = useState<TooltipRect | null>(null);
  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    const update = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const nextTrigger: TooltipRect = {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
      const panelEl = panelRef.current;
      const panel: TooltipSize =
        panelEl && panelEl.offsetWidth > 0
          ? { width: panelEl.offsetWidth, height: panelEl.offsetHeight }
          : { width: 320, height: 40 };
      setTrigger(nextTrigger);
      setPlacement(
        placeTooltipPanel({
          trigger: nextTrigger,
          panel,
          preferred,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        })
      );
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, preferred, rootRef, panelRef]);
  return { placement, trigger };
}

function bindTooltipTrigger(
  children: ReactElement<TriggerProps>,
  contentId: string,
  open: boolean,
  dispatch: (event: TooltipEvent) => void
): ReactElement<TriggerProps> {
  if (!isValidElement(children)) return children;
  const childProps = children.props;
  return cloneElement(children, {
    'aria-describedby': contentId,
    'aria-expanded': open,
    onClick: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      childProps.onClick?.(event);
      dispatch('click');
    },
    onFocus: (event: unknown) => {
      childProps.onFocus?.(event);
      dispatch('focus');
    },
    onBlur: (event: unknown) => {
      childProps.onBlur?.(event);
      dispatch('blur');
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      childProps.onKeyDown?.(event);
      if (event.key === 'Escape') dispatch('escape');
    },
  } as Partial<TriggerProps> & Record<string, unknown>);
}

const PANEL_CLASS =
  'block w-max max-w-[20rem] rounded-md bg-foreground px-3 py-1.5 text-left text-xs whitespace-normal text-background';

function TooltipVisual({
  id,
  open,
  className,
  contentProps,
  content,
  panelRef,
}: {
  id: string;
  open: boolean;
  className?: string;
  contentProps?: HTMLAttributes<HTMLSpanElement>;
  content: ReactNode;
  panelRef?: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span
      {...contentProps}
      ref={panelRef}
      id={id}
      role="tooltip"
      hidden={!open}
      className={cn(PANEL_CLASS, className)}
    >
      {content}
    </span>
  );
}

function TooltipPortaledPanel({
  id,
  className,
  contentProps,
  content,
  panelRef,
  wrapperRef,
  placement,
  trigger,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  className?: string;
  contentProps?: HTMLAttributes<HTMLSpanElement>;
  content: ReactNode;
  panelRef: RefObject<HTMLSpanElement | null>;
  wrapperRef: RefObject<HTMLSpanElement | null>;
  placement: TooltipPlacement;
  trigger: TooltipRect | null;
  onPointerEnter: () => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const overlap = 2;
  const pad = TOOLTIP_GAP + overlap;
  const top = placement.side === 'bottom' && trigger ? trigger.bottom - overlap : placement.top;
  return (
    <span
      ref={wrapperRef}
      className="z-50"
      style={{
        position: 'fixed',
        top,
        left: placement.left,
        paddingTop: placement.side === 'bottom' ? pad : 0,
        paddingBottom: placement.side === 'top' ? pad : 0,
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <TooltipVisual
        id={id}
        open
        className={className}
        contentProps={contentProps}
        content={content}
        panelRef={panelRef}
      />
    </span>
  );
}

export function Tooltip({
  children,
  content,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  side = 'top',
  contentProps,
}: TooltipProps) {
  const reactId = useId();
  const contentId = contentProps?.id ?? `tooltip-${reactId}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const { open, dispatch, setUncontrolled } = useTooltipOpen(openProp, defaultOpen, onOpenChange);
  useTooltipDismiss(open, rootRef, wrapperRef, onOpenChange, setUncontrolled);
  const { placement, trigger } = useTooltipPlacement(open, side, rootRef, panelRef);
  const triggerNode = bindTooltipTrigger(children, contentId, open, dispatch);
  const { className: contentClassName, ...restContentProps } = contentProps ?? {};
  const onPointerEnter = () => dispatch('pointerenter');
  const onPointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    if (nodeInside(event.relatedTarget as Node, rootRef.current, wrapperRef.current)) return;
    dispatch('pointerleave');
  };
  const canPortal = open && typeof document !== 'undefined' && placement !== null;
  const panel = canPortal ? (
    <TooltipPortaledPanel
      id={contentId}
      className={contentClassName}
      contentProps={restContentProps}
      content={content}
      panelRef={panelRef}
      wrapperRef={wrapperRef}
      placement={placement}
      trigger={trigger}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    />
  ) : (
    <TooltipVisual
      id={contentId}
      open={open}
      className={contentClassName}
      contentProps={restContentProps}
      content={content}
      panelRef={panelRef}
    />
  );

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      data-slot="tooltip"
      data-state={open ? 'open' : 'closed'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {triggerNode}
      {canPortal ? createPortal(panel, document.body) : panel}
    </span>
  );
}
