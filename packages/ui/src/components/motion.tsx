import * as React from 'react';

import { cn } from '../utils';

// 与 packages/theme/src/motion.css 中的 --tmex-motion-* token 一一对应（单位 ms）。
export const motionDurations = {
  fast: 100,
  standard: 150,
  layout: 200,
  slow: 300,
} as const;

export const revealClassName = 'tmex-reveal';

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
