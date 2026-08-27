import { describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import LoginPage from './LoginPage';

const BASE: AuthModeResponse = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
};

function render(mode: AuthModeResponse): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LoginPage mode={mode} />
    </MemoryRouter>
  );
}

describe('LoginPage', () => {
  test('standalone（mode:none）整页不渲染', () => {
    expect(render({ ...BASE, mode: 'none' })).toBe('');
  });

  test('mesh 模式渲染用户名 / 密码表单', () => {
    const html = render(BASE);
    expect(html).toContain('data-testid="login-page"');
    expect(html).toContain('data-testid="login-username"');
    expect(html).toContain('data-testid="login-password"');
    expect(html).toContain('value="alice"');
  });

  test('未开 TOTP 时不渲染验证码输入框，开了才渲染', () => {
    expect(render(BASE)).not.toContain('data-testid="login-totp"');
    expect(render({ ...BASE, totpEnabled: true })).toContain('data-testid="login-totp"');
  });

  test('passkey 按钮仅在本 origin 有 passkey 且环境可用时出现', () => {
    expect(render(BASE)).not.toContain('data-testid="login-passkey"');
    expect(render({ ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true })).toContain(
      'data-testid="login-passkey"'
    );
  });

  test('始终提供「为本入口注册 passkey」入口', () => {
    expect(render(BASE)).toContain('/account/security');
  });
});
