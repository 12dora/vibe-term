#!/usr/bin/env bun
/**
 * 场景 F：本机 Playwright → 公网 hub HTTPS（MAP 域名到公网 IP）。
 * Let's Encrypt：ignoreHTTPSErrors=false。private-ca：传 --insecure-tls（TLS 断言较弱）。
 */
import { chromium, type Page } from '../../../node_modules/.bun/playwright-core@1.58.2/node_modules/playwright-core/index.mjs';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] ?? '';
  return fallback;
}

const baseUrl = arg('base-url', 'https://ai.example.com:18443').replace(/\/+$/, '');
const username = arg('username', 'alice');
const password = arg('password');
const outDir = arg('out', 'scripts/hub-e2e/split/out');
const nodeAName = arg('node-a-name', 'node-a');
const nodeBName = arg('node-b-name', 'node-b');
const deviceAId = arg('device-a-id');
const nodeAId = arg('node-a-id');
const marker = arg('marker', 'TMEX_SPLIT_PW_MARKER');
const mapHost = arg('map-host', 'ai.example.com');
const mapIp = arg('map-ip', '4.2.2.1');
const caFile = arg('ca-file');
const insecureTls = process.argv.includes('--insecure-tls');

if (!password) {
  throw new Error('missing --password');
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
}

async function readTerminal(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as unknown as { __tmexE2eXterm?: { buffer: { active: { length: number; getLine: (y: number) => { translateToString: (t: boolean) => string } | null } } } }).__tmexE2eXterm;
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y += 1) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  });
}

const ignoreHTTPSErrors = insecureTls;
const browser = await chromium.launch({
  headless: true,
  ignoreHTTPSErrors,
  args: [
    `--host-resolver-rules=MAP ${mapHost} ${mapIp},EXCLUDE localhost`,
    '--disable-features=DnsOverHttps,UseDnsHttpsSvcb,AsyncDns',
  ],
});
const page = await browser.newPage({ ignoreHTTPSErrors, viewport: { width: 1400, height: 900 } });
const result: Record<string, unknown> = { ok: false, caFile: caFile || null, insecureTls };

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByTestId('login-page').waitFor({ timeout: 30_000 });
  await shot(page, 'f-01-login.png');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('sidebar').waitFor({ timeout: 90_000 });
  await shot(page, 'f-02-after-login.png');

  const sidebar = page.getByTestId('sidebar-node-list');
  await sidebar.waitFor({ timeout: 30_000 });
  const sidebarText = await sidebar.innerText();
  if (!sidebarText.includes(nodeAName) || !sidebarText.includes(nodeBName)) {
    throw new Error(`sidebar missing ${nodeAName}/${nodeBName}: ${sidebarText.slice(0, 500)}`);
  }
  result.sidebar = sidebarText.slice(0, 800);
  await shot(page, 'f-03-sidebar.png');

  if (deviceAId && nodeAId) {
    await page.goto(`${baseUrl}/n/${nodeAId}/devices/${deviceAId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } else {
    const device = page.locator('[data-testid^="device-item-"]').first();
    await device.waitFor({ timeout: 30_000 });
    const expand = page.locator('[data-testid^="device-expand-"]').first();
    if (await expand.count()) await expand.click();
    const pane = page.locator('[data-testid^="pane-item-"]').first();
    await pane.waitFor({ timeout: 20_000 });
    await pane.click();
  }

  await page.getByTestId('device-page').waitFor({ timeout: 30_000 });
  await page.locator('.xterm').first().waitFor({ timeout: 30_000 });
  await page.locator('.xterm').first().click();
  await page.keyboard.type(`echo ${marker}`);
  await page.keyboard.press('Enter');
  const deadline = Date.now() + 25_000;
  let termText = '';
  while (Date.now() < deadline) {
    termText = await readTerminal(page);
    if (termText.includes(marker)) break;
    await page.waitForTimeout(400);
  }
  await shot(page, 'f-04-terminal.png');
  if (!termText.includes(marker)) {
    throw new Error(`terminal marker not rendered: ${JSON.stringify(termText.slice(-800))}`);
  }
  result.terminal = true;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(`${baseUrl}/account/security`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByTestId('security-passkey-add').waitFor({ timeout: 20_000 });
  await page.getByTestId('security-passkey-name').fill('split-e2e');
  await page.getByTestId('security-passkey-add').click();
  await page.getByTestId('credential-prompt').waitFor({ timeout: 15_000 });
  await page.getByTestId('credential-prompt-password').fill(password);
  await page.getByTestId('credential-prompt-submit').click();
  await page.getByTestId('security-passkey-list').waitFor({ timeout: 30_000 });
  await shot(page, 'f-05-passkey-registered.png');
  result.passkeyRegistered = true;

  // Bun 下 playwright 的 request 上下文解析 Set-Cookie 时会拿到相对 URL 并抛 ERR_INVALID_URL，改在页面内 fetch
  await page
    .evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(() => undefined))
    .catch(() => undefined);
  await page.context().clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByTestId('login-page').waitFor({ timeout: 20_000 });
  const passkeyBtn = page.getByTestId('login-passkey');
  await passkeyBtn.waitFor({ timeout: 20_000 });
  await passkeyBtn.click();
  await page.getByTestId('sidebar').waitFor({ timeout: 90_000 });
  await shot(page, 'f-06-passkey-login.png');
  result.passkeyLogin = true;
  result.ok = true;
} catch (err) {
  result.error = err instanceof Error ? err.message : String(err);
  try {
    await shot(page, 'f-error.png');
  } catch {
    /* ignore */
  }
  process.stderr.write(`${result.error}\n`);
} finally {
  await Bun.write(`${outDir}/f-browser.json`, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await browser.close();
}

if (!result.ok) process.exit(1);
