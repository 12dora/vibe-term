import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { motionDurations, useReducedMotion } from '@tmex/ui/motion';
import type { ConnectionState } from '@tmex/ws-client';
import { Loader2, RefreshCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Phase = 'hidden' | 'entering' | 'visible' | 'exiting';

function shouldShowIndicator(state: ConnectionState): boolean {
  return (
    state === 'WS_CONNECTING' ||
    state === 'HELLO_NEGOTIATING' ||
    state === 'RECONNECT_BACKOFF' ||
    state === 'CLOSED'
  );
}

export function ConnectionIndicator() {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const connectionState = useTmuxStore((s) => s.connectionState);
  const hasConnectedOnce = useTmuxStore((s) => s.hasConnectedOnce);
  const [phase, setPhase] = useState<Phase>('hidden');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // reduced motion 下不走 entering/exiting 两个过渡态：没有 transition 就不会有 transitionend，
  // 退场必须直接落到 hidden，否则节点会停在 opacity:0 永不卸载。
  const reducedMotion = useReducedMotion();

  const shouldShow = shouldShowIndicator(connectionState);

  useEffect(() => {
    if (shouldShow && (phaseRef.current === 'hidden' || phaseRef.current === 'exiting')) {
      if (reducedMotion) {
        setPhase('visible');
        return;
      }
      setPhase('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPhase('visible');
        });
      });
    } else if (!shouldShow && phaseRef.current === 'visible') {
      setPhase(reducedMotion ? 'hidden' : 'exiting');
    }
  }, [shouldShow, reducedMotion]);

  const handleTransitionEnd = () => {
    if (phaseRef.current === 'exiting') {
      setPhase('hidden');
    }
  };

  if (phase === 'hidden') return null;

  const isClosed = connectionState === 'CLOSED';
  const isFirstConnect = !hasConnectedOnce && !isClosed;

  const easing = phase === 'exiting' ? 'var(--tmex-ease-in)' : 'var(--tmex-ease-out)';
  const duration = `${motionDurations.layout}ms`;
  const transitionStyle: React.CSSProperties = {
    bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
    transition: reducedMotion
      ? 'none'
      : `transform ${duration} ${easing}, opacity ${duration} ${easing}`,
    transform:
      phase === 'visible'
        ? 'translateY(0)'
        : phase === 'exiting'
          ? 'translateY(20px) scale(0.8)'
          : 'translateY(20px)',
    opacity: phase === 'visible' ? 1 : 0,
  };

  if (isClosed) {
    return (
      <div
        className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg px-3 py-2 gap-2 text-sm text-destructive cursor-pointer"
        style={transitionStyle}
        onTransitionEnd={handleTransitionEnd}
        onClick={() => runtime.client.reconnect()}
      >
        <RefreshCcw className="size-4" />
        <span>{t('websocket.reconnect')}</span>
      </div>
    );
  }

  if (isFirstConnect) {
    return (
      <div
        className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg p-2.5 text-sm text-muted-foreground"
        style={transitionStyle}
        onTransitionEnd={handleTransitionEnd}
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg px-3 py-2 gap-2 text-sm text-muted-foreground"
      style={transitionStyle}
      onTransitionEnd={handleTransitionEnd}
    >
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      <span>{t('websocket.reconnecting')}</span>
    </div>
  );
}
