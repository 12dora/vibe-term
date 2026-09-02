import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  type VirtualAuthenticator,
  addVirtualAuthenticator,
  loginWithPassword,
  logout,
  meshUrl,
  readMeshState,
} from './helpers/mesh';

// 文案断言按浏览器语言二选一：e2e 的 Chromium 是 en-US，本地跑成中文时也不该挂。
const INVALID_CREDENTIALS_COPY = /Incorrect username or password\.|用户名或密码错误。/;
const PASSKEY_ABORTED_COPY = /Passkey sign-in was cancelled\.|通行密钥授权已取消。/;
const PASSKEY_CHECK_COPY = /Complete the passkey check|请完成通行密钥验证/;

let state: MeshState;
let context: BrowserContext;
let page: Page;
let authenticator: VirtualAuthenticator;

/**
 * 整份文件共用一个 browser context 与一个虚拟认证器。
 *
 * 认证器里的私钥只活在这一个 context 里，而服务端一旦有了通行密钥就要求**所有**密码登录再过
 * 一次断言（`/api/auth/mode` 的 `passkeySecondFactor`）。每个用例各起一个 context，就等于第一条
 * 用例注册完之后，后面所有用例都拿不出那把凭证，密码登录全部卡在二次验证上。
 * 用例之间靠 `logout()` 回到未登录态，账号状态（那把已注册的通行密钥）刻意跨用例复用。
 */
test.beforeAll(async ({ browser }) => {
  state = readMeshState();
  context = await browser.newContext();
  page = await context.newPage();
  authenticator = await addVirtualAuthenticator(page);
});

test.afterAll(async () => {
  await context?.close();
});

// WebAuthn 只接受域名或 localhost origin，mesh e2e 的 entry 因此固定为
// http://localhost:<hubPort>（见 helpers/mesh-boot.ts）。
test('mesh: register a passkey on the entry node and log in with it', async () => {
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

// 注册过通行密钥之后，密码本身不再是完整凭证：服务端对 `method='root'` 的登录强制要求
// 断言，前端在密码提交后自动补一次仪式。复用上一条用例注册的那把凭证，不再重复注册。
test('mesh: after a passkey is registered, password login requires the passkey', async () => {
  await logout(page);
  await gotoLogin();

  expect(await authModeFlag('passkeySecondFactor')).toBe(true);

  const before = await totalSignCount();
  expect(before.credentials).toBeGreaterThan(0);

  await fillCredentials(state.password);
  await watchSubmitLabels();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 90_000 });

  // 认证器真的被问过：签名计数只会因为一次成功断言而增加。
  const after = await totalSignCount();
  expect(after.signCount).toBeGreaterThan(before.signCount);
  // 中间那一帧太短，轮询抓不住，用 MutationObserver 录下按钮上出现过的全部文案。
  expect((await readSubmitLabels()).join('\n')).toMatch(PASSKEY_CHECK_COPY);
  // 会话真的建起来了：`/api/mesh/nodes` 需要该 node 的会话 cookie。
  expect(await meshNodesStatus()).toBe(200);
});

// 密码错误只给一句中性文案：账号是否存在、错在密码还是签名，一律不外泄。
test('mesh: a wrong password shows the neutral message and stays on the login page', async () => {
  await logout(page);
  await gotoLogin();

  await fillCredentials(`${state.password}-wrong`);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-error')).toHaveText(INVALID_CREDENTIALS_COPY, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('login-page')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(await meshNodesStatus()).not.toBe(200);
});

// 二次验证被取消（这里用「认证器无法完成用户验证」模拟：服务端下发的 options 是
// userVerification:'required'，浏览器直接抛 NotAllowedError）：停在登录页，不产生任何会话。
test('mesh: a cancelled passkey check keeps the user on the login page', async () => {
  await logout(page);
  await gotoLogin();

  await authenticator.setUserVerified(false);
  try {
    await fillCredentials(state.password);
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toHaveText(PASSKEY_ABORTED_COPY, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('login-page')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/login');
    expect(await meshNodesStatus()).not.toBe(200);
  } finally {
    // 后面的用例还要用同一把凭证登录，认证器必须复原。
    await authenticator.setUserVerified(true);
  }
});

// 常规改密（不勾「同时移除…」）走 rotate-root-keep：passkey、TOTP 与全部会话都保留，
// 当前页面不该掉线，登出后原来那把 passkey 仍然能登录。
test('mesh: a routine password change keeps the passkey and the current session', async () => {
  await logout(page);
  await loginWithPassword(page, state);

  // 复用第一条用例注册的那把凭证：这里要断言的是「改密不会动它」，不需要再注册一把。
  await page.goto(meshUrl(state, '/?panel=security'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('security-passkey-list')).toBeVisible({ timeout: 30_000 });

  const nextPassword = `${state.password}-rotated`;
  // 点下按钮起就当密码已经变了：断言超时不等于服务端没应用，清理必须按最坏情况来。
  let rotated = false;
  try {
    // 复选框保持默认（未勾选）：这一条断言的就是「常规改密」这条路径。
    await expect(page.getByTestId('security-full-reset')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('password-warning')).toHaveCount(0);
    rotated = true;
    await changePassword(state.password, nextPassword);

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
    if (rotated) await restorePassword(nextPassword, state.password);
  }
});

async function gotoLogin(): Promise<void> {
  await page.goto(meshUrl(state, '/login'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 30_000 });
}

async function fillCredentials(password: string): Promise<void> {
  await page.getByTestId('login-username').fill(state.username);
  await page.getByTestId('login-password').fill(password);
}

/** `/api/auth/mode` 的某个布尔字段；从页面里发请求，Origin 与登录时完全一致。 */
async function authModeFlag(field: string): Promise<boolean | undefined> {
  return page.evaluate(
    (key) =>
      fetch('/api/auth/mode', { credentials: 'include' })
        .then((res) => res.json())
        .then((body: Record<string, unknown>) => body[key] as boolean | undefined),
    field
  );
}

/** 需要会话的接口的状态码：200 表示这个浏览器手上真的有 entry 的会话 cookie。 */
async function meshNodesStatus(): Promise<number> {
  return page.evaluate(() =>
    fetch('/api/mesh/nodes', { credentials: 'include' })
      .then((res) => res.status)
      .catch(() => 0)
  );
}

async function totalSignCount(): Promise<{ credentials: number; signCount: number }> {
  const rows = await authenticator.credentials();
  return {
    credentials: rows.length,
    signCount: rows.reduce((sum, row) => sum + row.signCount, 0),
  };
}

/** 录下登录按钮上出现过的所有文案：`passkeyCheck` 那一帧只存在于仪式的那几毫秒里。 */
async function watchSubmitLabels(): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __tmexSubmitLabels?: string[] };
    store.__tmexSubmitLabels = [];
    const button = document.querySelector('[data-testid="login-submit"]');
    if (!button) return;
    store.__tmexSubmitLabels.push(button.textContent ?? '');
    new MutationObserver(() => {
      store.__tmexSubmitLabels?.push(button.textContent ?? '');
    }).observe(button, { childList: true, characterData: true, subtree: true });
  });
}

async function readSubmitLabels(): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __tmexSubmitLabels?: string[] }).__tmexSubmitLabels ?? []
  );
}

/** 在已打开的账号安全面板里改一次密码，等成功提示。 */
async function changePassword(from: string, to: string): Promise<void> {
  await expect(page.getByTestId('security-old-password')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('security-old-password').fill(from);
  await page.getByTestId('security-new-password').fill(to);
  await page.getByTestId('security-confirm-password').fill(to);
  await page.getByTestId('security-change-password').click();
  // 先等「出结果」，再断言这个结果是成功：直接等 security-ok 的话，改密走成 notice / error
  // 时只会得到一句「元素没出现」，看不出服务端到底做了什么。
  const ok = page.getByTestId('security-ok');
  const outcome = ok.or(page.getByTestId('security-notice')).or(page.getByTestId('security-error'));
  await expect(outcome.first()).toBeVisible({ timeout: 60_000 });
  await expect(ok, `改密结果：${await outcome.first().innerText()}`).toBeVisible();
}

/**
 * 兜底把密码改回去：会话可能已经没了（用例在登出之后失败），所以先用当前密码登一次。
 * 这一步失败只打日志——真正的失败原因是 try 里那条断言，不能被清理异常盖掉。
 */
async function restorePassword(from: string, to: string): Promise<void> {
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
    await changePassword(from, to);
  } catch (err) {
    console.error(`mesh-passkey: 未能把密码改回 ${to}，后续用例需要重置 mesh 环境`, err);
  }
}
