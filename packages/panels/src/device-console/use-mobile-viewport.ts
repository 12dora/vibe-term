// 移动端判定 + iOS 地址栏收起：两者都只依赖视口，与控制台业务无关。

import { isIOSMobileBrowser } from '@tmex/terminal-ui';
import { useEffect, useMemo, useRef, useState } from 'react';

const detectMobile = () => window.innerWidth < 768 || 'ontouchstart' in window;

export function useMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && detectMobile());
  const isIOSBrowser = useMemo(() => isIOSMobileBrowser(), []);
  const collapseTriedRef = useRef(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(detectMobile());
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (!isMobile || !isIOSBrowser || collapseTriedRef.current) {
      return;
    }

    collapseTriedRef.current = true;
    const collapseAddressBar = () => {
      window.scrollTo(0, 1);
    };

    const rafId = window.requestAnimationFrame(collapseAddressBar);
    const timerA = window.setTimeout(collapseAddressBar, 120);
    const timerB = window.setTimeout(collapseAddressBar, 420);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerA);
      window.clearTimeout(timerB);
    };
  }, [isIOSBrowser, isMobile]);

  return isMobile;
}
