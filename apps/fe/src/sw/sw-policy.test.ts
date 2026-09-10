import { describe, expect, test } from 'bun:test';
import {
  PARTIAL_CHUNK_THRESHOLD,
  acceptsNetworkShell,
  isMeaningfulGap,
  planGenerationPrune,
  planGenerationSweep,
  precachePathSet,
  requestPathname,
  withGapFilled,
} from './sw-policy';

const PREFIX = 'vibeterm-shell-';
const CURRENT = 'vibeterm-shell-2.0.7-cccccccccccc';

describe('planGenerationPrune', () => {
  // caches.keys() 按创建顺序返回；activate 只留活动代，故「最旧」= 活动代。
  // 删错方向的后果是离线冷启动直接失效（iOS 上 activate 极少跑到）。
  test('保留最旧的活动代与正在装的这一代，删中间被顶掉的残留', () => {
    const names = [
      'vibeterm-shell-2.0.5-aaaaaaaaaaaa',
      'vibeterm-shell-2.0.6-bbbbbbbbbbbb',
      'vibeterm-shell-2.0.6-dddddddddddd',
      CURRENT,
    ];
    expect(planGenerationPrune(names, PREFIX, CURRENT)).toEqual([
      'vibeterm-shell-2.0.6-bbbbbbbbbbbb',
      'vibeterm-shell-2.0.6-dddddddddddd',
    ]);
  });

  test('只有活动代与本代时什么都不删', () => {
    expect(
      planGenerationPrune(['vibeterm-shell-2.0.6-aaaaaaaaaaaa', CURRENT], PREFIX, CURRENT)
    ).toEqual([]);
  });

  test('首次安装（没有别的代）不删任何东西', () => {
    expect(planGenerationPrune([CURRENT], PREFIX, CURRENT)).toEqual([]);
  });

  test('不碰其它前缀的缓存', () => {
    const names = ['workbox-precache', 'vibeterm-shell-old-1', 'vibeterm-shell-old-2', CURRENT];
    expect(planGenerationPrune(names, PREFIX, CURRENT)).toEqual(['vibeterm-shell-old-2']);
  });
});

describe('planGenerationSweep', () => {
  test('激活期删掉同前缀的其余各代，保留本代与无关缓存', () => {
    const names = ['unrelated', 'vibeterm-shell-a', 'vibeterm-shell-b', CURRENT];
    expect(planGenerationSweep(names, PREFIX, CURRENT)).toEqual([
      'vibeterm-shell-a',
      'vibeterm-shell-b',
    ]);
  });
});

describe('isMeaningfulGap', () => {
  const fonts = ['/fonts/a.woff2', '/fonts/b.woff2'];

  test('没有失败时不算缺口', () => {
    expect(isMeaningfulGap([], fonts)).toBe(false);
  });

  test('少量 chunk 失败按需回源即可，不打标', () => {
    expect(isMeaningfulGap(['/assets/x-1.js'], fonts)).toBe(false);
    expect(
      isMeaningfulGap(
        Array.from({ length: PARTIAL_CHUNK_THRESHOLD }, (_, i) => `/assets/x-${i}.js`),
        fonts
      )
    ).toBe(false);
  });

  test('超过阈值的 chunk 失败说明这次安装整体不可靠', () => {
    expect(
      isMeaningfulGap(
        Array.from({ length: PARTIAL_CHUNK_THRESHOLD + 1 }, (_, i) => `/assets/x-${i}.js`),
        fonts
      )
    ).toBe(true);
  });

  test('缺任何一个字体都算（终端会用错字形度量）', () => {
    expect(isMeaningfulGap(['/fonts/b.woff2'], fonts)).toBe(true);
  });
});

describe('acceptsNetworkShell', () => {
  test('2xx/3xx/4xx 都算服务端接管（访问门的 403 必须放行）', () => {
    for (const status of [200, 204, 304, 401, 403, 404, 499]) {
      expect(acceptsNetworkShell(status, 'basic')).toBe(true);
    }
  });

  test('302 跳转（Access 登录）放行', () => {
    expect(acceptsNetworkShell(0, 'opaqueredirect')).toBe(true);
  });

  test('5xx 挡住：升级期间反代的 502/504 不该顶掉可用的缓存壳', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(acceptsNetworkShell(status, 'basic')).toBe(false);
    }
  });

  test('错误响应与状态 0 都不采信', () => {
    expect(acceptsNetworkShell(0, 'error')).toBe(false);
    expect(acceptsNetworkShell(0, 'basic')).toBe(false);
  });
});

describe('precachePathSet / requestPathname / withGapFilled', () => {
  test('合并各档清单成路径集合', () => {
    expect(precachePathSet(['/index.html'], ['/assets/a.js'], ['/fonts/a.woff2'])).toEqual(
      new Set(['/index.html', '/assets/a.js', '/fonts/a.woff2'])
    );
  });

  test('取同源路径；非法 URL 返回 null', () => {
    expect(requestPathname('https://x/assets/a-1.js?v=1')).toBe('/assets/a-1.js');
    expect(requestPathname('not a url')).toBeNull();
  });

  test('补齐缺口返回新集合；无关路径返回 null', () => {
    const missing = new Set(['/assets/a.js', '/assets/b.js']);
    expect(withGapFilled(missing, '/assets/a.js')).toEqual(new Set(['/assets/b.js']));
    expect(withGapFilled(missing, '/assets/zzz.js')).toBeNull();
    expect(missing.size).toBe(2);
  });
});
