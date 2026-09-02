import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('mobile: topbar + sidebar sheet open/close', async ({ page }) => {
  await page.goto('/devices');
  await expect(page.getByTestId('devices-page')).toBeVisible();
  await expect(page.getByTestId('mobile-topbar')).toBeVisible();

  // 回归钉：移动视口下触发器必须是汉堡形态（曾因 useIsMobile 竞态渲染成桌面态 PanelLeft）
  await expect(page.getByTestId('mobile-sidebar-open').locator('svg.lucide-menu')).toBeVisible();

  await page.getByTestId('mobile-sidebar-open').click();
  await expect(page.getByTestId('mobile-sidebar-sheet')).toBeVisible();

  await page.getByTestId('mobile-sidebar-close').click();
  await expect(page.getByTestId('mobile-sidebar-sheet')).toHaveCount(0);
});

// 以 PWA（standalone）启动落在 `/` 时，直接展开侧边栏抽屉，而不是停在设备页。
test('mobile PWA: standalone launch lands on the sidebar sheet', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      if (!query.includes('display-mode: standalone')) return original(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  });

  await page.goto('/');
  await expect(page.getByTestId('mobile-sidebar-sheet')).toBeVisible();

  await page.getByTestId('mobile-sidebar-close').click();
  await expect(page.getByTestId('mobile-sidebar-sheet')).toHaveCount(0);
});
