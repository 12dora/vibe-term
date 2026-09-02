// 登录页：只渲染品牌 + 表单 + 一行错误；错误映射到真正的原因；self 登录成功即跳转。
// 无 DOM 测试环境，表单渲染用 react-dom/server 静态渲染，交互路径直接测纯函数与 store。

import { describe, expect, mock, test } from 'bun:test';
import {
  isCredentialFailure,
  loginErrorKey,
  loginErrorKeyFromException,
} from '@/auth/login-errors';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { WebAuthnError } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

/** `isWebAuthnAvailable()` 只看这两个全局，测试环境里补上就够了。 */
function installWebAuthnStub(): void {
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: class {},
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis.navigator, 'credentials', {
    value: { create: () => Promise.resolve(null), get: () => Promise.resolve(null) },
    configurable: true,
    writable: true,
  });
}

function withoutWebAuthn<T>(run: () => T): T {
  const saved = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      value: saved,
      configurable: true,
      writable: true,
    });
  }
}

installWebAuthnStub();

const passkeyCeremony = mock(async () => {});
mock.module('@/auth/session-login', () => ({
  establishSessionFromPasskey: passkeyCeremony,
  establishSessionFromPassword: mock(async () => {}),
  loginSelf: mock(async () => ({ ok: true })),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const {
  default: LoginPage,
  attemptPasskeyLogin,
  passkeyAffordance,
  passkeyBlockReason,
  runPasskeyLogin,
} = await import('./LoginPage');
type Phase = Parameters<Parameters<typeof runPasskeyLogin>[0]['setPhase']>[0];

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

  test('未开 TOTP 时不渲染验证码输入框，开了才渲染六个格子', () => {
    expect(render(BASE)).not.toContain('data-testid="login-totp"');
    const html = render({ ...BASE, totpEnabled: true });
    expect(html).toContain('data-testid="login-totp"');
    for (let i = 0; i < 6; i += 1) {
      expect(html).toContain(`data-testid="login-totp-${i}"`);
    }
    expect(html).not.toContain('data-testid="login-totp-6"');
    expect(html).toContain('autoComplete="one-time-code"');
  });

  test('本 origin 还没注册过 passkey 也照样给按钮（否则没人发现得了这个功能）', () => {
    const html = render({ ...BASE, passkeyAvailable: true, passkeysForThisOrigin: false });
    expect(html).toContain('data-testid="login-passkey"');
    expect(html).not.toContain('data-testid="login-passkey-unavailable"');
  });

  test('已注册 passkey 时同样是这个按钮', () => {
    expect(render({ ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true })).toContain(
      'data-testid="login-passkey"'
    );
  });

  test('地址不支持 passkey（http + IP）时给一行说明，不给按钮', () => {
    const html = render({ ...BASE, passkeyAvailable: false });
    expect(html).not.toContain('data-testid="login-passkey"');
    expect(html).toContain('data-testid="login-passkey-unavailable"');
    expect(html).toContain('text-xs text-muted-foreground');
  });

  test('浏览器不支持 WebAuthn 时按钮和说明都不出现', () => {
    const html = withoutWebAuthn(() => render({ ...BASE, passkeyAvailable: true }));
    expect(html).not.toContain('data-testid="login-passkey"');
    expect(html).not.toContain('data-testid="login-passkey-unavailable"');
  });

  test('不再提供 passkey 注册入口（注册只在账号安全面板里）', () => {
    const html = render({ ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true });
    expect(html).not.toContain('/account/security');
    expect(html).not.toContain('panel=security');
    expect(html).not.toContain('data-testid="login-register-passkey"');
  });

  test('不渲染任何内部状态：登录目标列表 / 逐台进度都没有', () => {
    const html = render(BASE);
    expect(html).not.toContain('data-testid="login-targets"');
    expect(html).not.toContain('data-testid="login-progress"');
  });
});

describe('passkey 入口判定', () => {
  test('地址可用就给按钮，不可用给说明，环境不支持就整栏不给', () => {
    expect(passkeyAffordance({ passkeyAvailable: true }, true)).toBe('button');
    expect(passkeyAffordance({ passkeyAvailable: false }, true)).toBe('unavailable');
    expect(passkeyAffordance({ passkeyAvailable: true }, false)).toBe('none');
    expect(passkeyAffordance({ passkeyAvailable: false }, false)).toBe('none');
  });

  test('默认参数走 isWebAuthnAvailable()，测试环境里已 stub 成可用', () => {
    expect(passkeyAffordance({ passkeyAvailable: true })).toBe('button');
    expect(withoutWebAuthn(() => passkeyAffordance({ passkeyAvailable: true }))).toBe('none');
  });

  test('本 origin 没注册过 passkey → 前置判定拦下并给出「去哪儿加」', () => {
    expect(passkeyBlockReason({ passkeysForThisOrigin: false })).toBe(
      'auth.login.passkeyNotRegistered'
    );
    expect(passkeyBlockReason({ passkeysForThisOrigin: true })).toBeNull();
  });

  test('被拦下时不发起 WebAuthn 仪式，只回文案 key', async () => {
    passkeyCeremony.mockClear();
    const key = await attemptPasskeyLogin({
      mode: { ...BASE, passkeyAvailable: true, passkeysForThisOrigin: false },
      uid: 'user-1',
      api: {} as AuthApi,
    });
    expect(key).toBe('auth.login.passkeyNotRegistered');
    expect(passkeyCeremony).not.toHaveBeenCalled();
  });

  test('已注册时照常走仪式，成功回 null', async () => {
    passkeyCeremony.mockClear();
    const key = await attemptPasskeyLogin({
      mode: { ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true },
      uid: 'user-1',
      api: {} as AuthApi,
    });
    expect(key).toBeNull();
    expect(passkeyCeremony).toHaveBeenCalledTimes(1);
  });

  test('仪式抛错 → 按 passkey 路径映射文案，不外泄原始码', async () => {
    passkeyCeremony.mockClear();
    passkeyCeremony.mockImplementationOnce(() => {
      throw new WebAuthnError('aborted', 'x');
    });
    const key = await attemptPasskeyLogin({
      mode: { ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true },
      uid: 'user-1',
      api: {} as AuthApi,
    });
    expect(key).toBe('auth.errors.PASSKEY_ABORTED');
  });
});

describe('runPasskeyLogin 编排', () => {
  const mode: AuthModeResponse = { ...BASE, passkeyAvailable: true, passkeysForThisOrigin: true };

  function collect(finishLogin: (method: 'passkey') => Promise<void>) {
    const phases: Phase[] = [];
    const errors: string[] = [];
    return {
      phases,
      errors,
      deps: {
        mode,
        uid: 'user-1',
        api: {} as AuthApi,
        finishLogin,
        setPhase: (phase: Phase) => phases.push(phase),
        onErrorKey: (key: string) => errors.push(key),
      },
    };
  }

  test('一路顺利：只推进到 deriving，收尾交给 finishLogin，不报错', async () => {
    passkeyCeremony.mockClear();
    const finishLogin = mock(async () => {});
    const run = collect(finishLogin);
    await runPasskeyLogin(run.deps);
    expect(passkeyCeremony).toHaveBeenCalledTimes(1);
    expect(finishLogin).toHaveBeenCalledTimes(1);
    expect(run.phases).toEqual(['deriving']);
    expect(run.errors).toEqual([]);
  });

  test('收尾抛错（节点签名 / 会话钥落盘）→ 给出报错并退回 idle，不是卡在登录中', async () => {
    passkeyCeremony.mockClear();
    const run = collect(async () => {
      throw new Error('persist failed');
    });
    await runPasskeyLogin(run.deps);
    expect(run.errors).toEqual(['auth.errors.LOGIN_FAILED']);
    expect(run.phases.at(-1)).toBe('idle');
  });

  test('收尾抛出带 code 的错误 → 按 passkey 路径映射文案', async () => {
    passkeyCeremony.mockClear();
    const run = collect(async () => {
      throw Object.assign(new Error('x'), { code: 'DELEGATION_BAD_SIGNATURE' });
    });
    await runPasskeyLogin(run.deps);
    expect(run.errors).toEqual(['auth.errors.PASSKEY_VERIFY_FAILED']);
    expect(run.phases.at(-1)).toBe('idle');
  });

  test('仪式失败时不进入收尾', async () => {
    passkeyCeremony.mockClear();
    passkeyCeremony.mockImplementationOnce(() => {
      throw new WebAuthnError('aborted', 'x');
    });
    const finishLogin = mock(async () => {});
    const run = collect(finishLogin);
    await runPasskeyLogin(run.deps);
    expect(finishLogin).not.toHaveBeenCalled();
    expect(run.errors).toEqual(['auth.errors.PASSKEY_ABORTED']);
    expect(run.phases.at(-1)).toBe('idle');
  });
});

describe('登录失败文案', () => {
  test('密码路径下凭证类失败全部收敛到同一句中性文案（不泄露账号是否存在）', () => {
    for (const code of [
      'INVALID_CREDENTIALS',
      'DELEGATION_BAD_SIGNATURE',
      'BAD_SIGNATURE',
      'ROOT_KEY_MISMATCH',
      'BAD_DELEGATION',
      'DELEGATION_METHOD_MISMATCH',
      'UNKNOWN_USER',
    ]) {
      expect(loginErrorKey(code, 'password')).toBe('auth.errors.invalidCredentials');
    }
  });

  test('二次验证失败按自己的原因说，不混进「用户名或密码错误」', () => {
    expect(loginErrorKey('PASSKEY_INVALID', 'password')).toBe('auth.errors.PASSKEY_VERIFY_FAILED');
    expect(loginErrorKey('PASSKEY_INVALID', 'passkey')).toBe('auth.errors.PASSKEY_VERIFY_FAILED');
    expect(loginErrorKey('NO_PASSKEY_FOR_ORIGIN', 'password')).toBe(
      'auth.login.passkeySecondFactorNotRegistered'
    );
    expect(loginErrorKey('PASSKEY_CREDENTIAL_UNKNOWN', 'password')).toBe(
      'auth.login.passkeySecondFactorNotRegistered'
    );
    expect(loginErrorKey('PASSKEY_REQUIRED', 'password')).toBe('auth.errors.PASSKEY_REQUIRED');
  });

  test('用户取消二次验证仪式 → 取消文案（密码路径同样适用）', () => {
    expect(loginErrorKeyFromException(new WebAuthnError('aborted', 'x'), 'password')).toBe(
      'auth.errors.PASSKEY_ABORTED'
    );
    expect(loginErrorKey('PASSKEY_ABORTED', 'password')).toBe('auth.errors.PASSKEY_ABORTED');
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
  });

  test('服务端回 NO_PASSKEY_FOR_ORIGIN 时与前置提示同一句文案', () => {
    expect(loginErrorKey('NO_PASSKEY_FOR_ORIGIN', 'passkey')).toBe(
      'auth.login.passkeyNotRegistered'
    );
    expect(loginErrorKeyFromException({ code: 'NO_PASSKEY_FOR_ORIGIN' }, 'passkey')).toBe(
      'auth.login.passkeyNotRegistered'
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

describe('isCredentialFailure', () => {
  test('凭证本身不可用才丢会话钥', () => {
    expect(isCredentialFailure('INVALID_CREDENTIALS')).toBe(true);
    expect(isCredentialFailure('BAD_SIGNATURE')).toBe(true);
    expect(isCredentialFailure('UNKNOWN_USER')).toBe(true);
  });

  test('PASSKEY_INVALID：同一份断言永远过不了，必须连会话钥一起丢', () => {
    expect(isCredentialFailure('PASSKEY_INVALID')).toBe(true);
  });

  test('PASSKEY_REQUIRED 只是少带了一次断言，会话钥必须留着', () => {
    expect(isCredentialFailure('PASSKEY_REQUIRED')).toBe(false);
    expect(isCredentialFailure('TOTP_INVALID')).toBe(false);
    expect(isCredentialFailure('NETWORK_ERROR')).toBe(false);
    expect(isCredentialFailure(undefined)).toBe(false);
  });
});
