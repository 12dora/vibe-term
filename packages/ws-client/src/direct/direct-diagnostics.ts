import type { DirectDiagnostics, DirectIceDiagnostics } from './types';

export interface PageVisibility {
  hidden: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

/** 取不到 `document`（单测 / 非 DOM）时一律按「可见」处理。 */
export function browserVisibility(): PageVisibility {
  return {
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    subscribe: (listener) => {
      if (typeof document === 'undefined') return () => undefined;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

/** 低于此粒度（ms）的 RTT 抖动不触发诊断订阅通知。 */
export const RTT_PUBLISH_QUANTIZE_MS = 5;

export function quantizedRtt(rtt: number | null): number | null {
  if (rtt == null || !Number.isFinite(rtt)) return null;
  return Math.round(rtt / RTT_PUBLISH_QUANTIZE_MS) * RTT_PUBLISH_QUANTIZE_MS;
}

export function sameIce(a: DirectIceDiagnostics | null, b: DirectIceDiagnostics | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.connectionState === b.connectionState &&
    a.iceConnectionState === b.iceConnectionState &&
    a.localCandidateType === b.localCandidateType &&
    a.remoteCandidateType === b.remoteCandidateType &&
    a.selectedPair === b.selectedPair
  );
}

/**
 * 诊断快照是否「对订阅者无意义的变化」。RTT 只按粗粒度比较：
 * 连接态 / 候选对 / 路径 / 熔断字段变了仍立即发布。
 */
export function sameDiagnosticsForPublish(
  prev: DirectDiagnostics,
  next: DirectDiagnostics
): boolean {
  return (
    prev.path === next.path &&
    prev.route === next.route &&
    quantizedRtt(prev.rtt) === quantizedRtt(next.rtt) &&
    prev.cooling === next.cooling &&
    prev.until === next.until &&
    prev.failures === next.failures &&
    prev.level === next.level &&
    prev.lastFailureKind === next.lastFailureKind &&
    sameIce(prev.ice ?? null, next.ice ?? null)
  );
}
