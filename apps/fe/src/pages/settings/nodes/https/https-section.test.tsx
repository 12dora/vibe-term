// HTTPS 区块的静态渲染：模式分派、状态头、自签 CA 区、ACME 状态区与未登录提示。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 NodesPage / NodesTab 测试同一套做法）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TlsStatusResponse, TlsUpdateRequest } from '@tmex/api-client/local/tls-types';
import type { TlsMutationKind } from './tls-mutations';

let status: TlsStatusResponse | null = null;
let loginRequired = false;
let loading = false;
let loadError: string | null = null;
let pending: TlsMutationKind | null = null;
let confirming: TlsUpdateRequest | null = null;

// `useTlsStatus` 走 React Query，而 `FilePage.test.tsx` 用 `mock.module` 全局换掉了
// `@tanstack/react-query`——直接渲染真 hook 会读到那份泄漏的 mock。这里只测渲染分支。
mock.module('./use-tls-status', () => ({
  TLS_STATUS_QUERY_KEY: ['tls-status'],
  ACME_POLL_INTERVAL_MS: 3000,
  useTlsStatus: () => ({
    status,
    loading,
    loginRequired,
    error: loadError,
    refresh: () => undefined,
    setStatus: () => undefined,
  }),
}));

// 变更锁的行为在 `tls-mutations.test.ts` 里测；这里只驱动它的输出，验证 busy 真的落到每个控件上。
const actualMutations = await import('./tls-mutations');
mock.module('./tls-mutations', () => ({
  ...actualMutations,
  useTlsMutations: (_api: unknown, current: TlsStatusResponse | null) => ({
    pending,
    confirming,
    busy: actualMutations.isTlsBusy(pending, current),
    requestSave: () => undefined,
    confirmSave: () => undefined,
    cancelSave: () => undefined,
    renew: () => undefined,
  }),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { ApiClient } = await import('@tmex/api-client');
const { TlsApi } = await import('@tmex/api-client/local/tls-api');
const { HttpsSection } = await import('./https-section');

const api = new TlsApi(new ApiClient('', () => Promise.resolve(new Response('{}'))));

function tls(overrides: Partial<TlsStatusResponse> = {}): TlsStatusResponse {
  return {
    mode: 'none',
    trustProxy: false,
    tlsPort: 9443,
    bindHost: '0.0.0.0',
    sans: [],
    caFingerprint: null,
    certificate: null,
    listener: { running: false, port: null, error: null },
    acme: null,
    restartRequired: false,
    ...overrides,
  };
}

function render(props: { showHubUrlHint?: boolean; hostname?: string | null } = {}): string {
  return renderToStaticMarkup(
    <HttpsSection api={api} hostname={props.hostname ?? 'hub.lan'} {...props} />
  );
}

/** 只看标签自身的 `disabled=""`：class 里的 `disabled:` 变体前缀不算数。 */
function isDisabled(html: string, testId: string): boolean {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!tag) throw new Error(`missing element: ${testId}`);
  return / disabled=""/.test(tag[0]);
}

beforeEach(() => {
  status = null;
  loginRequired = false;
  loading = false;
  loadError = null;
  pending = null;
  confirming = null;
});

describe('HttpsSection 加载与权限', () => {
  test('未登录时给登录提示，不渲染模式选择', () => {
    loginRequired = true;
    const html = render();
    expect(html).toContain('data-testid="https-login-required"');
    expect(html).not.toContain('data-testid="https-mode-chooser"');
  });

  test('加载失败时展示错误而不是空白', () => {
    loadError = 'boom';
    const html = render();
    expect(html).toContain('data-testid="https-load-failed"');
    expect(html).toContain('boom');
  });

  test('standalone 提示 hub 公开地址必须是 https', () => {
    status = tls();
    expect(render({ showHubUrlHint: true })).toContain('data-testid="https-hub-url-hint"');
    expect(render()).not.toContain('data-testid="https-hub-url-hint"');
  });
});

describe('HttpsSection none / external', () => {
  test('none 模式渲染四个模式卡与关闭面板', () => {
    status = tls();
    const html = render();
    expect(html).toContain('data-testid="https-mode-none"');
    expect(html).toContain('data-testid="https-mode-external"');
    expect(html).toContain('data-testid="https-mode-selfsigned"');
    expect(html).toContain('data-testid="https-mode-acme"');
    expect(html).toContain('data-testid="https-none-panel"');
    expect(html).toContain('data-testid="https-no-certificate"');
    expect(html).toMatch(/data-testid="https-mode-none"[^>]*data-selected="true"/);
  });

  test('external 模式渲染 trustProxy 开关，restartRequired 时给重启入口', () => {
    status = tls({ mode: 'external', trustProxy: true, restartRequired: true });
    const html = render();
    expect(html).toContain('data-testid="https-external-panel"');
    expect(html).toContain('data-testid="https-trust-proxy"');
    expect(html).toContain('data-testid="https-restart-required"');
    expect(html).toContain('data-testid="https-restart-now"');
    expect(html).not.toContain('data-testid="https-selfsigned-panel"');
  });
});

describe('HttpsSection selfsigned', () => {
  const selfsigned = () =>
    tls({
      mode: 'selfsigned',
      sans: ['hub.lan', '192.168.1.10'],
      caFingerprint: 'ab'.repeat(32),
      certificate: {
        subject: 'CN=hub.lan',
        sans: ['hub.lan', '192.168.1.10'],
        notBefore: Date.now() - 1000,
        notAfter: Date.now() + 86_400_000 * 100,
        issuer: 'CN=tmex local CA',
      },
      listener: { running: true, port: 9443, error: null },
    });

  test('已签发时给出指纹、CA 下载与安装指引', () => {
    status = selfsigned();
    const html = render();
    expect(html).toContain('data-testid="https-selfsigned-panel"');
    expect(html).toContain('data-testid="https-ca-fingerprint"');
    expect(html).toContain('data-testid="https-ca-download"');
    expect(html).toContain('href="/api/tls/ca.crt"');
    expect(html).toContain('download="tmex-ca.crt"');
    for (const platform of ['macos', 'ios', 'windows', 'android', 'linux']) {
      expect(html).toContain(`data-testid="https-ca-guide-${platform}"`);
    }
    expect(html).toContain('data-testid="https-selfsigned-renew"');
  });

  test('SAN 列表来自后端状态，证书摘要与监听端口都展示', () => {
    status = selfsigned();
    const html = render();
    expect(html).toContain('hub.lan');
    expect(html).toContain('192.168.1.10');
    expect(html).toContain('CN=tmex local CA');
    expect(html).toContain('data-testid="https-listener-state"');
    expect(html).toContain('data-testid="https-cert-valid-until"');
  });

  test('未签发时不出现 CA 区，SAN 预填地址栏主机名', () => {
    status = tls({ mode: 'selfsigned' });
    const html = render({ hostname: 'box.lan' });
    expect(html).not.toContain('data-testid="https-ca-block"');
    expect(html).toContain('box.lan');
  });

  test('回环主机名不预填 SAN', () => {
    status = tls({ mode: 'selfsigned' });
    const html = render({ hostname: 'localhost' });
    expect(html).toContain('data-testid="https-sans-empty"');
  });
});

describe('HttpsSection acme', () => {
  test('http-01 不显示 Cloudflare token 输入框', () => {
    status = tls({
      mode: 'acme',
      acme: {
        email: 'ops@example.com',
        domain: 'hub.example.com',
        challenge: 'http-01',
        staging: false,
        status: 'pending',
        lastError: null,
        lastAttemptAt: Date.now(),
        nextRenewAt: null,
        hasCloudflareToken: false,
      },
    });
    const html = render();
    expect(html).toContain('data-testid="https-acme-panel"');
    expect(html).toContain('data-testid="https-acme-pending"');
    expect(html).not.toContain('data-testid="https-acme-token"');
    expect(isDisabled(html, 'https-acme-renew')).toBe(true);
  });

  test('dns-01 失败时给出 token 输入框与人话提示', () => {
    status = tls({
      mode: 'acme',
      acme: {
        email: 'ops@example.com',
        domain: 'hub.example.com',
        challenge: 'dns-01',
        staging: true,
        status: 'error',
        lastError: 'dns propagation timeout',
        lastAttemptAt: Date.now(),
        nextRenewAt: Date.now() + 86_400_000,
        hasCloudflareToken: true,
      },
    });
    const html = render();
    expect(html).toContain('data-testid="https-acme-token"');
    expect(html).toContain('data-testid="https-acme-error"');
    expect(html).toContain('dns propagation timeout');
    expect(html).toContain('data-testid="https-acme-next-renew"');
    expect(html).toContain('nodes.https.acme.hints.dns01');
  });
});

describe('HttpsSection 变更串行化', () => {
  const acmeStatus = (state: 'idle' | 'pending') =>
    tls({
      mode: 'acme',
      acme: {
        email: 'ops@example.com',
        domain: 'hub.example.com',
        challenge: 'http-01',
        staging: false,
        status: state,
        lastError: null,
        lastAttemptAt: Date.now(),
        nextRenewAt: null,
        hasCloudflareToken: false,
      },
    });

  test('保存在途时续签按钮同样禁用（两者共用一把锁）', () => {
    status = acmeStatus('idle');
    pending = 'save';
    const html = render();
    expect(isDisabled(html, 'https-acme-renew')).toBe(true);
    expect(isDisabled(html, 'https-acme-save')).toBe(true);
    expect(isDisabled(html, 'https-acme-domain')).toBe(true);
    expect(isDisabled(html, 'https-mode-none-input')).toBe(true);
  });

  test('续签在途时保存按钮禁用', () => {
    status = acmeStatus('idle');
    pending = 'renew';
    const html = render();
    expect(isDisabled(html, 'https-acme-save')).toBe(true);
    expect(isDisabled(html, 'https-acme-renew')).toBe(true);
  });

  test('空闲时保存与续签都可用', () => {
    status = acmeStatus('idle');
    const html = render();
    expect(isDisabled(html, 'https-acme-save')).toBe(false);
    expect(isDisabled(html, 'https-acme-renew')).toBe(false);
    expect(isDisabled(html, 'https-mode-none-input')).toBe(false);
  });

  test('ACME 后台签发期间模式选择与表单全部禁用', () => {
    status = acmeStatus('pending');
    const html = render();
    expect(isDisabled(html, 'https-acme-save')).toBe(true);
    expect(isDisabled(html, 'https-acme-renew')).toBe(true);
    expect(isDisabled(html, 'https-mode-selfsigned-input')).toBe(true);
  });

  test('未确认时不渲染停监听对话框', () => {
    status = tls({ mode: 'selfsigned', listener: { running: true, port: 9443, error: null } });
    expect(render()).not.toContain('data-testid="https-confirm-stop"');
  });

  test('登记了待确认请求时不会崩，页面其余部分照常渲染', () => {
    // AlertDialog 走 Portal，静态渲染取不到它的内容；确认流程本身在 tls-mutations.test.ts 里测。
    status = tls({ mode: 'selfsigned', listener: { running: true, port: 9443, error: null } });
    confirming = { mode: 'none' };
    expect(render()).toContain('data-testid="https-mode-chooser"');
  });
});
