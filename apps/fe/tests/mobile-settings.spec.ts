import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('mobile: settings tabs + select + webhook crud are tappable', async ({ page }) => {
  const webhookUrl = `https://example.com/e2e-webhook-mobile-${Date.now()}`;
  const webhookSecret = `secret-${Date.now()}`;
  let createdWebhookEventMask: string[] = [];
  const webhooks: Array<{
    id: string;
    enabled: boolean;
    url: string;
    secret: string;
    eventMask: string[];
    createdAt: string;
    updatedAt: string;
  }> = [];

  // Telegram endpoints call real Telegram APIs. Mock to keep e2e deterministic.
  const bots: Array<{
    id: string;
    name: string;
    enabled: boolean;
    allowAuthRequests: boolean;
    createdAt: string;
    updatedAt: string;
    pendingCount: number;
    authorizedCount: number;
  }> = [];

  await page.route('**/api/settings/telegram/bots**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (req.method() === 'GET' && url.pathname === '/api/settings/telegram/bots') {
      await route.fulfill({ status: 200, json: { bots } });
      return;
    }

    if (req.method() === 'POST' && url.pathname === '/api/settings/telegram/bots') {
      const body = req.postDataJSON() as {
        name?: string;
        enabled?: boolean;
        allowAuthRequests?: boolean;
      } | null;
      const now = new Date().toISOString();
      const id = `e2e-${Date.now()}`;
      bots.push({
        id,
        name: body?.name ?? id,
        enabled: body?.enabled ?? true,
        allowAuthRequests: body?.allowAuthRequests ?? true,
        createdAt: now,
        updatedAt: now,
        pendingCount: 0,
        authorizedCount: 0,
      });
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    if (req.method() === 'DELETE' && url.pathname.startsWith('/api/settings/telegram/bots/')) {
      const botId = url.pathname.split('/')[5];
      const index = bots.findIndex((bot) => bot.id === botId);
      if (index >= 0) {
        bots.splice(index, 1);
      }
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    if (req.method() === 'GET' && url.pathname.includes('/chats')) {
      await route.fulfill({ status: 200, json: { chats: [] } });
      return;
    }

    if (req.method() === 'POST' || req.method() === 'PATCH') {
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    await route.fallback();
  });

  await page.route('**/api/webhooks**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (req.method() === 'GET' && url.pathname === '/api/webhooks') {
      await route.fulfill({ status: 200, json: { webhooks } });
      return;
    }

    if (req.method() === 'POST' && url.pathname === '/api/webhooks') {
      const body = req.postDataJSON() as { eventMask?: string[] } | null;
      createdWebhookEventMask = body?.eventMask ?? [];
      const now = new Date().toISOString();
      const webhook = {
        id: `webhook-${Date.now()}`,
        enabled: true,
        url: webhookUrl,
        secret: webhookSecret,
        eventMask: createdWebhookEventMask,
        createdAt: now,
        updatedAt: now,
      };
      webhooks.push(webhook);
      await route.fulfill({
        status: 201,
        json: {
          webhook,
        },
      });
      return;
    }

    if (req.method() === 'DELETE' && url.pathname.startsWith('/api/webhooks/')) {
      const webhookId = url.pathname.split('/')[3];
      const index = webhooks.findIndex((webhook) => webhook.id === webhookId);
      if (index >= 0) {
        webhooks.splice(index, 1);
      }
      await route.fulfill({ status: 200, json: { success: true } });
      return;
    }

    await route.fallback();
  });

  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByTestId('mobile-topbar')).toBeVisible();

  // Tabs should be tappable on mobile.
  await page.getByTestId('settings-tab-notifications').click();
  await expect(page.getByTestId('settings-enable-browser-notification-toast')).toBeVisible();
  await page.getByTestId('settings-enable-browser-notification-toast').click();

  // Select should open and be clickable without being covered.
  await page.getByTestId('settings-tab-general').click();
  await page.getByTestId('settings-language-select').click();
  await page.locator('[data-slot="select-content"]').getByText('简体中文').click();
  // 弹层收完再往下点：移动视口下它盖住半屏，退场动画没跑完时保存按钮点不到。
  await expect(page.locator('[data-slot="select-content"]')).toBeHidden();
  // 选中即生效（无需保存 / 刷新）：标签文案与 <html lang> 立即切换
  await expect(page.getByTestId('settings-tab-general')).toHaveText('通用');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByTestId('settings-save').click();

  // Webhook CRUD should work on mobile (now under the notifications tab).
  await page.getByTestId('settings-tab-notifications').click();
  await page.getByTestId('webhook-url-input').fill(webhookUrl);
  await page.getByTestId('webhook-secret-input').fill(webhookSecret);
  await page.getByTestId('webhook-add').click();

  // 先等列表里出现这一条（即 POST 已被 mock 接住并回写），再断言请求体里的事件掩码：
  // 点完立刻读 createdWebhookEventMask 是在和一次异步请求赛跑。
  const webhookItem = page.locator(
    `[data-testid="webhook-item"][data-webhook-url="${webhookUrl}"]`
  );
  await expect(webhookItem).toBeVisible();
  expect(createdWebhookEventMask).toContain('terminal_notification');
  await webhookItem.getByTestId('webhook-delete').click();
  await expect(webhookItem).toHaveCount(0);

  // Reset language to keep later tests stable.
  await page.getByTestId('settings-tab-general').click();
  await page.getByTestId('settings-language-select').click();
  await page.locator('[data-slot="select-content"]').getByText('English').click();
  await expect(page.locator('[data-slot="select-content"]')).toBeHidden();
  await page.getByTestId('settings-save').click();
});
