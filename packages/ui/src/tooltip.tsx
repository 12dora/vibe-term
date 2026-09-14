import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { cn } from './utils';

export type TooltipOpenState = { open: boolean; sticky: boolean };

export type TooltipEvent = 'pointerenter' | 'pointerleave' | 'focus' | 'blur' | 'click' | 'escape';

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
  contentProps?: HTMLAttributes<HTMLDivElement>;
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

function useTooltipDismiss(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
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
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onOpenChange, rootRef, setUncontrolled]);
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
  const { open, dispatch, setUncontrolled } = useTooltipOpen(openProp, defaultOpen, onOpenChange);
  useTooltipDismiss(open, rootRef, onOpenChange, setUncontrolled);
  const trigger = bindTooltipTrigger(children, contentId, open, dispatch);
  const { className: contentClassName, ...restContentProps } = contentProps ?? {};
  const sideClass =
    side === 'top'
      ? 'bottom-full left-1/2 mb-1 -translate-x-1/2'
      : 'top-full left-1/2 mt-1 -translate-x-1/2';

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      data-slot="tooltip"
      data-state={open ? 'open' : 'closed'}
      onPointerEnter={() => dispatch('pointerenter')}
      onPointerLeave={() => dispatch('pointerleave')}
    >
      {trigger}
      <div
        {...restContentProps}
        id={contentId}
        role="tooltip"
        hidden={!open}
        className={cn(
          'absolute z-50 w-max max-w-[20rem] rounded-md bg-foreground px-3 py-1.5 text-left text-xs whitespace-normal text-background',
          sideClass,
          contentClassName
        )}
      >
        {content}
      </div>
    </span>
  );
}
