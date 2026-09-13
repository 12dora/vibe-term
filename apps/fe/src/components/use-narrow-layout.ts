// 窄屏版式判定（Tailwind 的 sm = 40rem 以下）。
//
// 宽表在手机上摆不下，要换成一张张记录卡。两套版式**只挂一套 DOM**：同一批 testid 若同时
// 出现两次，e2e 的严格选择器会当场报错，因此不用「两套都渲染、CSS 藏一套」的做法。
//
// 没有可信的视口读数时一律按宽屏处理（服务端渲染、单测里的裸 window）。判据是
// `MediaQueryList.media`：单测里的 matchMedia 桩不认识查询串，一律回同一个 `matches`
// 且不带 `media`——照它的读数会把别的用例的宽表也换成卡片。

import { useEffect, useState } from 'react';

const NARROW_QUERY = '(max-width: 39.999rem)';

function narrowQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  const query = window.matchMedia(NARROW_QUERY);
  return typeof query?.media === 'string' && query.media.length > 0 ? query : null;
}

export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() => narrowQuery()?.matches === true);

  useEffect(() => {
    const query = narrowQuery();
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    setNarrow(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
