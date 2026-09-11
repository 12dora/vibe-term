import { describe, expect, test } from 'bun:test';
import {
  PARTIAL_CHUNK_THRESHOLD,
  SW_LINK_HINTS_MESSAGE,
  acceptsNetworkShell,
  isMeaningfulGap,
  linkHintsFrom,
  linkHintsMessage,
  parseLinkHints,
  planGenerationPrune,
  planGenerationSweep,
  precachePathSet,
  requestPathname,
  shouldPrecacheLazy,
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

describe('链路提示与 lazy 档分级', () => {
  test('拿不到提示时照装：桌面浏览器普遍不给 effectiveType，行为必须与分级之前一致', () => {
    expect(shouldPrecacheLazy(null)).toBe(true);
    expect(shouldPrecacheLazy({ saveData: false, effectiveType: null })).toBe(true);
  });

  test('省流量一律跳过，哪怕报的是 4g', () => {
    expect(shouldPrecacheLazy({ saveData: true, effectiveType: '4g' })).toBe(false);
    expect(shouldPrecacheLazy({ saveData: true, effectiveType: null })).toBe(false);
  });

  test('非 4g 一律跳过，4g 才装', () => {
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect(shouldPrecacheLazy({ saveData: false, effectiveType })).toBe(false);
    }
    expect(shouldPrecacheLazy({ saveData: false, effectiveType: '4g' })).toBe(true);
    // 未来出现的取值（'5g' 之类）当作未知：宁可多装也不要把新硬件误判成弱网
    expect(shouldPrecacheLazy({ saveData: false, effectiveType: '5g' })).toBe(false);
  });

  test('linkHintsFrom 归一化：没有 connection 的浏览器给出「未知」提示', () => {
    expect(linkHintsFrom(undefined)).toEqual({ saveData: false, effectiveType: null });
    expect(linkHintsFrom({ saveData: true, effectiveType: '3g' })).toEqual({
      saveData: true,
      effectiveType: '3g',
    });
    expect(linkHintsFrom({ effectiveType: 42 as unknown as string })).toEqual({
      saveData: false,
      effectiveType: null,
    });
  });

  test('页面发的消息能被 SW 原样解回来', () => {
    const message = linkHintsMessage({ saveData: true, effectiveType: '2g' });
    expect(message.type).toBe(SW_LINK_HINTS_MESSAGE);
    expect(parseLinkHints(message)).toEqual({ saveData: true, effectiveType: '2g' });
  });

  test('别的消息不当链路提示', () => {
    expect(parseLinkHints({ type: 'vibeterm:sw-skip-waiting' })).toBeNull();
    expect(parseLinkHints(null)).toBeNull();
    expect(parseLinkHints('vibeterm:sw-link-hints')).toBeNull();
  });

  test('提示缺字段时按未知处理，仍然照装', () => {
    const hints = parseLinkHints({ type: SW_LINK_HINTS_MESSAGE });
    expect(hints).toEqual({ saveData: false, effectiveType: null });
    expect(shouldPrecacheLazy(hints)).toBe(true);
  });
});

describe('主动跳过 lazy 档不算「这一代装坏了」', () => {
  const fonts = ['/fonts/a.woff2', '/fonts/b.woff2'];

  test('跳过的 lazy 档根本不进 failed 列表，判不出缺口 ⇒ 导航预算留在 600 ms', () => {
    // 安装时 optional = [] + fonts，字体全装上 ⇒ failed 为空
    expect(isMeaningfulGap([], fonts)).toBe(false);
  });

  test('字体真装不上仍然算缺口（这与分级无关）', () => {
    expect(isMeaningfulGap([fonts[0] as string], fonts)).toBe(true);
  });

  test('装了 lazy 档而零星失败，仍按阈值判定', () => {
    const few = Array.from({ length: PARTIAL_CHUNK_THRESHOLD }, (_, i) => `/assets/c${i}.js`);
    expect(isMeaningfulGap(few, fonts)).toBe(false);
    expect(isMeaningfulGap([...few, '/assets/more.js'], fonts)).toBe(true);
  });
});
