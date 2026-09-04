import { describe, expect, test } from 'bun:test';
import {
  SHEET_CONTENT_SELECTOR,
  isStandaloneDisplay,
  releaseFocusInsideSheet,
  shouldOpenSidebarOnLaunch,
} from './standalone';

const mediaWindow = (matches: boolean) => ({
  matchMedia: (query: string) => ({ matches: matches && query === '(display-mode: standalone)' }),
});

describe('isStandaloneDisplay', () => {
  test('display-mode: standalone 命中时为 true', () => {
    expect(isStandaloneDisplay(mediaWindow(true))).toBe(true);
  });

  test('navigator.standalone 为 true 时（旧版 iOS）也算', () => {
    expect(isStandaloneDisplay({ ...mediaWindow(false), navigator: { standalone: true } })).toBe(
      true
    );
  });

  test('两者都不满足时为 false', () => {
    expect(isStandaloneDisplay({ ...mediaWindow(false), navigator: { standalone: false } })).toBe(
      false
    );
  });

  test('window 上两个能力都不存在时为 false', () => {
    expect(isStandaloneDisplay({})).toBe(false);
  });

  test('没有 window（SSR）时为 false', () => {
    const saved = globalThis.window;
    (globalThis as { window?: unknown }).window = undefined;
    try {
      expect(isStandaloneDisplay()).toBe(false);
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
  });
});

describe('shouldOpenSidebarOnLaunch', () => {
  const base = { isMobile: true, standalone: true, launchPathname: '/', alreadyFired: false };

  test('手机 + PWA + 首页时打开', () => {
    expect(shouldOpenSidebarOnLaunch(base)).toBe(true);
  });

  test('桌面端不打开', () => {
    expect(shouldOpenSidebarOnLaunch({ ...base, isMobile: false })).toBe(false);
  });

  test('浏览器标签页（非 PWA）不打开', () => {
    expect(shouldOpenSidebarOnLaunch({ ...base, standalone: false })).toBe(false);
  });

  test('深链不打开', () => {
    for (const launchPathname of [
      '/settings',
      '/devices',
      '/n/abc',
      '/n/abc/devices/1',
      '/login',
    ]) {
      expect(shouldOpenSidebarOnLaunch({ ...base, launchPathname })).toBe(false);
    }
  });

  test('每次加载只触发一次', () => {
    expect(shouldOpenSidebarOnLaunch({ ...base, alreadyFired: true })).toBe(false);
  });
});

// StandaloneLanding 的 effect 只有两个 ref：落地路径（挂载时定死）与「已触发」。
// 这里按同样的方式跑一遍，覆盖路由变化 / isMobile 晚到 / StrictMode 双跑。
function mountLanding(launchPathname: string, standalone = true) {
  const launchRef = launchPathname;
  let fired = false;
  let opened = 0;
  return {
    runEffect(isMobile: boolean) {
      const shouldOpen = shouldOpenSidebarOnLaunch({
        isMobile,
        standalone,
        launchPathname: launchRef,
        alreadyFired: fired,
      });
      if (!shouldOpen) return;
      fired = true;
      opened += 1;
    },
    get opened() {
      return opened;
    },
  };
}

describe('StandaloneLanding 的落地判定', () => {
  test('深链启动后再导航到首页也不打开', () => {
    const landing = mountLanding('/settings');
    landing.runEffect(true);
    // 路由变到 `/` 不改变落地路径，effect 依赖里也没有 pathname；再跑一次仍不打开。
    landing.runEffect(true);
    expect(landing.opened).toBe(0);
  });

  test('isMobile 晚一帧才为真时补开，且只开一次', () => {
    const landing = mountLanding('/');
    landing.runEffect(false);
    expect(landing.opened).toBe(0);
    landing.runEffect(true);
    landing.runEffect(true);
    expect(landing.opened).toBe(1);
  });

  test('StrictMode 下 effect 跑两遍也只开一次', () => {
    const landing = mountLanding('/');
    landing.runEffect(true);
    landing.runEffect(true);
    expect(landing.opened).toBe(1);
  });

  test('非 PWA 时首页也不打开', () => {
    const landing = mountLanding('/', false);
    landing.runEffect(true);
    expect(landing.opened).toBe(0);
  });
});

// 抽屉一打开，Base UI 就把焦点移到里面第一个可聚焦元素——侧边栏顶上的「关闭侧边栏」。
// 自动弹出时这一下必须收回来，否则 PWA 冷启动后左上角一直挂着一圈焦点环。
function fakeNode(insideSheet: boolean) {
  let blurred = false;
  return {
    closest: (selector: string) => (insideSheet && selector === SHEET_CONTENT_SELECTOR ? {} : null),
    blur: () => {
      blurred = true;
    },
    get blurred() {
      return blurred;
    },
  };
}

describe('releaseFocusInsideSheet', () => {
  test('焦点落在抽屉里 → 收回来', () => {
    const node = fakeNode(true);
    expect(releaseFocusInsideSheet(node)).toBe(true);
    expect(node.blurred).toBe(true);
  });

  test('焦点在抽屉外（用户自己点的）→ 一动不动', () => {
    const node = fakeNode(false);
    expect(releaseFocusInsideSheet(node)).toBe(false);
    expect(node.blurred).toBe(false);
  });

  test('没有焦点 / 拿到的不是元素时安全返回', () => {
    for (const node of [null, undefined, {}, 'body']) {
      expect(releaseFocusInsideSheet(node)).toBe(false);
    }
  });
});

// 侧边栏抽屉的容器选择器与 packages/ui 的 SheetContent 对齐，改名会让上面的收回逻辑静默失效。
describe('SHEET_CONTENT_SELECTOR', () => {
  test('指向 SheetContent 的 data-slot', () => {
    expect(SHEET_CONTENT_SELECTOR).toBe('[data-slot="sheet-content"]');
  });
});
