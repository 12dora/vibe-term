// 链路诊断浮层的定位钩子。浮层原来挂在徽标里（`absolute`），在手机上有两个躲不开的问题：
// 页头的祖先只要有 `overflow` / `transform` 就会把它裁掉或改掉包含块，而纵向根本没有夹过——
// 卡片高度超过视口就直接从下面顶出去。改成 portal 到 body 的 `fixed`，坐标全部现量：
// 横向夹回可见视口，纵向夹进「徽标下方剩余高度」并在明显不够时翻到上方，卡片内部自己滚。
//
// 手机上量的必须是**视觉**视口（`visualViewport`）：地址栏收起、键盘弹出、双指缩放之后，
// 只有它是用户真正看得见的那块。纯计算在 ./popover-clamp（有单测），这里只负责量和订阅。

import { useEffect, useLayoutEffect, useState } from 'react';
import { type PopoverBox, placePopover } from './popover-clamp';

// 无 DOM（SSR / bun test）时降级成 useEffect，避免 React 的 useLayoutEffect 警告。
const useMeasureEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/**
 * PWA 顶部安全区的解析值。`--vibeterm-safe-area-top` 是 `env(safe-area-inset-top, 0px)`，
 * 计算值阶段已经替换成具体像素；拿不到（老浏览器不替换 env）就按 0 处理，反正翻到上方
 * 本来就只发生在徽标离屏底很近的时候。
 */
function safeAreaTop(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    '--vibeterm-safe-area-top'
  );
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

function measureFrom(anchor: DOMRect): PopoverBox {
  const visual = window.visualViewport;
  const root = document.documentElement;
  return placePopover({
    anchor,
    viewport: {
      width: visual?.width ?? root.clientWidth ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
      offsetLeft: visual?.offsetLeft ?? 0,
      offsetTop: visual?.offsetTop ?? 0,
      layoutHeight: root.clientHeight || window.innerHeight,
    },
    safeTop: safeAreaTop(),
  });
}

/**
 * 展开期间跟住徽标：窗口尺寸、任意祖先的滚动（捕获阶段才收得到）、视觉视口的缩放与平移
 * 都会让徽标的视口坐标变，量一次就定死会让浮层飘在原地。
 */
export function usePopoverPlacement(
  anchorRef: { current: HTMLElement | null },
  open: boolean
): PopoverBox | null {
  const [placement, setPlacement] = useState<PopoverBox | null>(null);

  useMeasureEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (anchor) setPlacement(measureFrom(anchor));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [open, anchorRef]);

  return placement;
}
