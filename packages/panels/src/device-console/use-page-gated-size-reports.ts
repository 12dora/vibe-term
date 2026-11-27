// 页面不活跃（隐藏 / pagehide / freeze）期间扣住终端尺寸上报，重新活跃后补发最新一次：
// 后台页面发出的 resize/sync 会被网关当成可见声明，把刚撤回的视口声明重新点亮。

import { useEffect, useRef } from 'react';
import {
  type PageActivityTracker,
  type SizeReportGate,
  type SizeReportKind,
  createPageActivityTracker,
  createSizeReportGate,
} from './page-activity';

export function usePageGatedSizeReports(
  dispatch: (kind: SizeReportKind, cols: number, rows: number) => void,
  /** 目标 pane、设备连接或单屏/分屏变化时丢弃留存的尺寸 */
  targetKey: string
): SizeReportGate {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const trackerRef = useRef<PageActivityTracker | null>(null);
  const gateRef = useRef<SizeReportGate | null>(null);
  if (!gateRef.current) {
    gateRef.current = createSizeReportGate({
      isActive: () =>
        trackerRef.current
          ? trackerRef.current.isActive()
          : typeof document === 'undefined' || document.visibilityState !== 'hidden',
      dispatch: (kind, cols, rows) => dispatchRef.current(kind, cols, rows),
    });
  }
  const gate = gateRef.current;

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const tracker = createPageActivityTracker(document, window);
    trackerRef.current = tracker;
    const unsubscribe = tracker.subscribe(() => gate.flush());
    return () => {
      unsubscribe();
      tracker.dispose();
      trackerRef.current = null;
    };
  }, [gate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: targetKey 变化即丢弃留存尺寸
  useEffect(() => {
    return () => gate.discard();
  }, [targetKey, gate]);

  return gate;
}
