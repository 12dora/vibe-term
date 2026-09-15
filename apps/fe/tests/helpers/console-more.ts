import { type Page, expect } from '@playwright/test';

// 终端页顶栏的刷新 / 输入模式 / 分享 / 监视规则四项收进了 ⋯ 菜单（console-more-button），
// 条目的 testid 没变，spec 只需在点条目前先把菜单打开。

export async function openConsoleMore(page: Page): Promise<void> {
  const trigger = page.getByTestId('console-more-button');
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  await expect(page.getByTestId('console-more-menu')).toBeVisible();
}

/** 打开 ⋯ 菜单并点其中一项 */
export async function clickConsoleMoreItem(page: Page, testId: string): Promise<void> {
  await openConsoleMore(page);
  await page.getByTestId(testId).click();
}
