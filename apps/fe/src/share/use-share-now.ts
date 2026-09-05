// 倒计时用的时钟：active 为 false 时不起定时器（永久分享 / 未锁定时不空转）。

import { useEffect, useState } from 'react';

export function useShareNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
