// 账号安全面板（原 `/account/security` 整页）：三个区块的静态渲染与 standalone 下的空渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（副作用里的 passkey 列表请求不会跑）。

import { describe, expect, test } from 'bun:test';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const panelModule = await import('./account-security-panel');
const AccountSecurityPanel = panelModule.default;

const MESH_MODE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: true,
  rootEpoch: 0,
};

const idleApi = {
  listPasskeys: () => Promise.reject(new Error('unexpected call')),
} as unknown as AuthApi;

function render(mode: AuthModeResponse): string {
  return renderToStaticMarkup(<AccountSecurityPanel mode={mode} api={idleApi} />);
}

describe('AccountSecurityPanel', () => {
  test('mesh 下渲染改密 / TOTP / 通行密钥三块', () => {
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="account-security-panel"');
    expect(html).toContain('data-testid="security-change-password"');
    expect(html).toContain('data-testid="security-totp-set"');
    expect(html).toContain('data-testid="security-passkey-add"');
    expect(html).toContain('data-testid="password-warning"');
  });

  test('standalone（mode:none）整块不渲染', () => {
    expect(render({ ...MESH_MODE, mode: 'none' })).toBe('');
  });

  test('缺 uid / kdf 参数时只给一行说明，不摆出可操作的表单', () => {
    const html = render({ ...MESH_MODE, uid: null, kdfParams: null });
    expect(html).not.toContain('data-testid="security-change-password"');
    expect(html).toContain('auth.errors.UNKNOWN_USER');
  });

  test('未开始设置 TOTP 时不渲染二维码与验证码格子', () => {
    const html = render(MESH_MODE);
    expect(html).not.toContain('data-testid="security-totp-uri"');
    expect(html).not.toContain('data-testid="security-totp-code"');
  });

  test('已启用 TOTP 时多一个关闭入口', () => {
    expect(render(MESH_MODE)).not.toContain('data-testid="security-totp-clear"');
    expect(render({ ...MESH_MODE, totpEnabled: true })).toContain(
      'data-testid="security-totp-clear"'
    );
  });

  test('不再暴露整页路由（面板由 `?panel=security` 驱动）', () => {
    expect('accountSecurityRoute' in panelModule).toBe(false);
    expect('PageTitle' in panelModule).toBe(false);
  });
});
