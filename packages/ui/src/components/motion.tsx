import * as React from 'react';

import { cn } from '../utils';

// 与 packages/theme/src/motion.css 中的 --tmex-motion-* token 一一对应（单位 ms）。
export const motionDurations = {
  fast: 100,
  standard: 150,
  layout: 200,
  slow: 300,
} as const;

export type MotionDurationName = keyof typeof motionDurations;

export const revealClassName = 'tmex-reveal';
export const fadeClassName = 'tmex-fade';
export const scaleInClassName = 'tmex-scale-in';
export const staggerClassName = 'tmex-stagger';

export function staggerItemStyle(index: number): React.CSSProperties {
  return { '--tmex-stagger-index': Math.max(0, index) } as React.CSSProperties;
}

export function revealDelayStyle(delayMs?: number): React.CSSProperties | undefined {
  if (delayMs === undefined) return undefined;
  return { animationDelay: `${Math.max(0, delayMs)}ms` };
}

export type RevealProps = React.ComponentProps<'div'> & {
  as?: React.ElementType;
  delayMs?: number;
};

export function Reveal({
  as: Component = 'div',
  className,
  style,
  delayMs,
  ...props
}: RevealProps) {
  const delayStyle = revealDelayStyle(delayMs);
  return (
    <Component
      data-slot="reveal"
      className={cn(revealClassName, className)}
      style={delayStyle ? { ...style, ...delayStyle } : style}
      {...props}
    />
  );
}

export type StaggerProps = React.ComponentProps<'div'> & {
  as?: React.ElementType;
  startIndex?: number;
};

// 每个子节点套一层 div 承载 --tmex-stagger-index：比 cloneElement 安全（不依赖子节点接受 style）。
export function Stagger({
  as: Component = 'div',
  className,
  children,
  startIndex = 0,
  ...props
}: StaggerProps) {
  return (
    <Component data-slot="stagger" className={cn(staggerClassName, className)} {...props}>
      {React.Children.map(children, (child, index) =>
        child === null || child === undefined || child === false ? (
          child
        ) : (
          <div data-slot="stagger-item" style={staggerItemStyle(startIndex + index)}>
            {child}
          </div>
        )
      )}
    </Component>
  );
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
