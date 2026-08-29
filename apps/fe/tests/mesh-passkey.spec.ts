import { expect, test } from '@playwright/test';
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
