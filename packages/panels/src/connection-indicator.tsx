import { useRuntime, useTmuxStore } from '@vibeterm/stores/react';
import { motionDurations, useReducedMotion } from '@vibeterm/ui/motion';
import type { ConnectionState } from '@vibeterm/ws-client';
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

/** 连上之后指示器再留这么久才退场：握手成功后立刻又断的会话不会让它一闪一闪。 */
export const INDICATOR_LINGER_MS = 1000;

function useLingering(active: boolean, lingerMs: number): boolean {
  const [lingering, setLingering] = useState(active);
  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), lingerMs);
    return () => clearTimeout(timer);
  }, [active, lingerMs]);
  return active || lingering;
}

type IndicatorMode = 'closed' | 'first' | 'reconnecting';

/** 要不要显示、用哪种样式。退场前的停留期里状态已是 READY：沿用上一种样式（首连转圈不换成「重连中」）。 */
function useIndicatorPresence(
  state: ConnectionState,
  hasConnectedOnce: boolean
): { show: boolean; mode: IndicatorMode } {
  const modeRef = useRef<IndicatorMode>('first');
  if (state !== 'READY') {
    modeRef.current = state === 'CLOSED' ? 'closed' : hasConnectedOnce ? 'reconnecting' : 'first';
  }
  const show = useLingering(shouldShowIndicator(state), INDICATOR_LINGER_MS);
  const mode = state === 'READY' && modeRef.current === 'closed' ? 'reconnecting' : modeRef.current;
  return { show, mode };
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

  const { show: shouldShow, mode } = useIndicatorPresence(connectionState, hasConnectedOnce);

  useEffect(() => {
    if (reducedMotion) {
      // 偏好可能在过渡中途切换：此时不会再有 transitionend，直接落到终态
      setPhase(shouldShow ? 'visible' : 'hidden');
      return;
    }
    if (shouldShow && (phaseRef.current === 'hidden' || phaseRef.current === 'exiting')) {
      setPhase('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPhase('visible');
        });
      });
    } else if (!shouldShow && phaseRef.current === 'visible') {
      setPhase('exiting');
    }
  }, [shouldShow, reducedMotion]);

  const handleTransitionEnd = () => {
    if (phaseRef.current === 'exiting') {
      setPhase('hidden');
    }
  };

  if (phase === 'hidden') return null;

  const isClosed = mode === 'closed';
  const isFirstConnect = mode === 'first';

  const easing = phase === 'exiting' ? 'var(--vibeterm-ease-in)' : 'var(--vibeterm-ease-out)';
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
      <button
        type="button"
        className="fixed z-50 right-4 flex items-center rounded-full bg-background border border-border shadow-lg px-3 py-2 gap-2 text-sm text-destructive cursor-pointer"
        style={transitionStyle}
        onTransitionEnd={handleTransitionEnd}
        onClick={() => runtime.client.reconnect()}
      >
        <RefreshCcw className="size-4" />
        <span>{t('websocket.reconnect')}</span>
      </button>
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
