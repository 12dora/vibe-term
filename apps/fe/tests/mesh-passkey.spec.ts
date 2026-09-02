import { type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  addVirtualAuthenticator,
  loginWithPassword,
  logout,
  meshUrl,
  readMeshState,
} from './helpers/mesh';

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

// WebAuthn 只接受域名或 localhost origin，mesh e2e 的 entry 因此固定为
// http://localhost:<hubPort>（见 helpers/mesh-boot.ts）。
test('mesh: register a passkey on the entry node and log in with it', async ({ page }) => {
  await addVirtualAuthenticator(page);
  await loginWithPassword(page, state);

  // 账号安全已从整页改成右侧滑出面板：URL 协议是任意路由 + `?panel=security`。
  await page.goto(meshUrl(state, '/?panel=security'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('security-passkey-add')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('security-passkey-name').fill('mesh-e2e');
  await page.getByTestId('security-passkey-add').click();

  // 注册 add-passkey key-log 记录需要 root key，前端弹密码确认框重新派生。
  await expect(page.getByTestId('credential-prompt')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('credential-prompt-password').fill(state.password);
  await page.getByTestId('credential-prompt-submit').click();
  await expect(page.getByTestId('security-passkey-list')).toBeVisible({ timeout: 30_000 });

  await logout(page);

  await page.goto(meshUrl(state, '/login'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 30_000 });
  const passkeyButton = page.getByTestId('login-passkey');
  await expect(passkeyButton).toBeVisible({ timeout: 30_000 });
  await passkeyButton.click();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 90_000 });
});

// 常规改密（不勾「同时移除…」）走 rotate-root-keep：passkey、TOTP 与全部会话都保留，
// 当前页面不该掉线，登出后原来那把 passkey 仍然能登录。
test('mesh: a routine password change keeps the passkey and the current session', async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  await loginWithPassword(page, state);

  await page.goto(meshUrl(state, '/?panel=security'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('security-passkey-add')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('security-passkey-name').fill('mesh-e2e-keep');
  await page.getByTestId('security-passkey-add').click();
  await expect(page.getByTestId('credential-prompt')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('credential-prompt-password').fill(state.password);
  await page.getByTestId('credential-prompt-submit').click();
  await expect(page.getByTestId('security-passkey-list')).toBeVisible({ timeout: 30_000 });

  const nextPassword = `${state.password}-rotated`;
  // 点下按钮起就当密码已经变了：断言超时不等于服务端没应用，清理必须按最坏情况来。
  let rotated = false;
  try {
    // 复选框保持默认（未勾选）：这一条断言的就是「常规改密」这条路径。
    await expect(page.getByTestId('security-full-reset')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('password-warning')).toHaveCount(0);
    rotated = true;
    await changePassword(page, state.password, nextPassword);

    // 会话没被撤销：无需重新登录，侧边栏与通行密钥列表都还在。
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
    await page.goto(meshUrl(state, '/?panel=security'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('security-passkey-list')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });

    await logout(page);

    await page.goto(meshUrl(state, '/login'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 30_000 });
    const passkeyButton = page.getByTestId('login-passkey');
    await expect(passkeyButton).toBeVisible({ timeout: 30_000 });
    await passkeyButton.click();
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 90_000 });
  } finally {
    // 后续用例（以及重跑）都按 state.password 登录：中途哪一步失败都得把密码改回去，
    // 否则整个 mesh e2e 从这里开始全军覆没。
    if (rotated) await restorePassword(page, nextPassword, state.password);
  }
});

/** 在已打开的账号安全面板里改一次密码，等成功提示。 */
async function changePassword(page: Page, from: string, to: string): Promise<void> {
  await expect(page.getByTestId('security-old-password')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('security-old-password').fill(from);
  await page.getByTestId('security-new-password').fill(to);
  await page.getByTestId('security-confirm-password').fill(to);
  await page.getByTestId('security-change-password').click();
  await expect(page.getByTestId('security-ok')).toBeVisible({ timeout: 60_000 });
}

/**
 * 兜底把密码改回去：会话可能已经没了（用例在登出之后失败），所以先用当前密码登一次。
 * 这一步失败只打日志——真正的失败原因是 try 里那条断言，不能被清理异常盖掉。
 */
async function restorePassword(page: Page, from: string, to: string): Promise<void> {
  try {
    await page.goto(meshUrl(state, '/?panel=security'), { waitUntil: 'domcontentloaded' });
    if (
      !(await page
        .getByTestId('security-old-password')
        .isVisible()
        .catch(() => false))
    ) {
      await loginWithPassword(page, { ...state, password: from });
      await page.goto(meshUrl(state, '/?panel=security'), { waitUntil: 'domcontentloaded' });
    }
    await changePassword(page, from, to);
  } catch (err) {
    console.error(`mesh-passkey: 未能把密码改回 ${to}，后续用例需要重置 mesh 环境`, err);
  }
}
