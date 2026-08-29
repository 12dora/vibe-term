// 登录页：只渲染品牌 + 表单 + 一行错误；错误映射到真正的原因；self 登录成功即跳转。
// 无 DOM 测试环境，表单渲染用 react-dom/server 静态渲染，交互路径直接测纯函数与 store。

import { describe, expect, test } from 'bun:test';
import { loginErrorKey, loginErrorKeyFromException } from '@/auth/login-errors';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { WebAuthnError } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { default: LoginPage } = await import('./LoginPage');

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

  test('mesh 模式渲染品牌 + 用户名 / 密码表单', () => {
    const html = render(BASE);
    expect(html).toContain('data-testid="login-page"');
    expect(html).toContain('data-testid="brand"');
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

  test('不再提供 passkey 注册入口（注册只在账号安全里）', () => {
    const html = render({ ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true });
    expect(html).not.toContain('/account/security');
    expect(html).not.toContain('data-testid="login-register-passkey"');
  });

  test('不渲染任何内部状态：登录目标列表 / 逐台进度都没有', () => {
    const html = render(BASE);
    expect(html).not.toContain('data-testid="login-targets"');
    expect(html).not.toContain('data-testid="login-progress"');
  });
});

describe('登录失败文案', () => {
  test('密码路径下签名类失败一律说「密码不正确」，不是「所有节点都失败」', () => {
    expect(loginErrorKey('DELEGATION_BAD_SIGNATURE', 'password')).toBe('auth.errors.wrongPassword');
    expect(loginErrorKey('BAD_SIGNATURE', 'password')).toBe('auth.errors.wrongPassword');
    expect(loginErrorKey('ROOT_KEY_MISMATCH', 'password')).toBe('auth.errors.wrongPassword');
  });

  test('验证码 / 网络错误各自映射到自己的文案', () => {
    expect(loginErrorKey('TOTP_REQUIRED', 'password')).toBe('auth.errors.TOTP_REQUIRED');
    expect(loginErrorKey('TOTP_INVALID', 'password')).toBe('auth.errors.TOTP_INVALID');
    expect(loginErrorKey('NETWORK_ERROR', 'password')).toBe('auth.errors.NETWORK_ERROR');
    expect(loginErrorKey('NODE_LIST_FAILED', 'password')).toBe('auth.login.nodeListFailed');
  });

  test('passkey 路径下签名类失败不能说成密码错', () => {
    expect(loginErrorKey('DELEGATION_BAD_SIGNATURE', 'passkey')).toBe(
      'auth.errors.PASSKEY_VERIFY_FAILED'
    );
    expect(loginErrorKey('NO_PASSKEY_FOR_ORIGIN', 'passkey')).toBe(
      'auth.errors.NO_PASSKEY_FOR_ORIGIN'
    );
  });

  test('认不出的码落到通用文案，绝不把原始码显示出来', () => {
    expect(loginErrorKey('SOME_NEW_BACKEND_CODE', 'password')).toBe('auth.errors.LOGIN_FAILED');
    expect(loginErrorKey(undefined, 'password')).toBe('auth.errors.LOGIN_FAILED');
    expect(loginErrorKeyFromException(new Error('boom'), 'password')).toBe(
      'auth.errors.LOGIN_FAILED'
    );
  });

  test('用户取消 passkey 仪式 → 取消文案', () => {
    expect(loginErrorKeyFromException(new WebAuthnError('aborted', 'x'), 'passkey')).toBe(
      'auth.errors.PASSKEY_ABORTED'
    );
  });
});
