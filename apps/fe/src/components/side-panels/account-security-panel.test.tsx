// 账号安全面板（原 `/account/security` 整页）：三个区块的静态渲染与 standalone 下的空渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（副作用里的 passkey 列表请求不会跑）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const cleared = mock(() => Promise.resolve(true));
const resumed = mock(async (_opts: unknown) => ({ ok: true }) as { ok: boolean; code?: string });
mock.module('@/auth/session-key-store', () => ({
  clearSessionKey: cleared,
  getSessionKey: () => ({ entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e' }),
}));
mock.module('@/auth/session-login', () => ({
  resumeSessionAfterPasswordChange: resumed,
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const panelModule = await import('./account-security-panel');
const AccountSecurityPanel = panelModule.default;
const { PasswordSection, finishPasswordChange, passwordChangeFollowUp, securityActionErrorText } =
  panelModule;

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

const RESOLVED_MODE = {
  ...MESH_MODE,
  uid: 'user-1',
  kdfParams: MESH_MODE.kdfParams as NonNullable<AuthModeResponse['kdfParams']>,
};

function renderPasswordSection(
  overrides: Partial<AuthModeResponse> & { initialFullReset?: boolean } = {}
): string {
  const { initialFullReset, ...modeOverrides } = overrides;
  return renderToStaticMarkup(
    <PasswordSection
      mode={{
        ...RESOLVED_MODE,
        ...modeOverrides,
        uid: 'user-1',
        kdfParams: RESOLVED_MODE.kdfParams,
      }}
      api={idleApi}
      uid="user-1"
      onDone={() => undefined}
      initialFullReset={initialFullReset}
    />
  );
}

/** 静态渲染下 i18n 未初始化，`t()` 直接回落成 key。 */
const t = (key: string, options?: Record<string, unknown>) =>
  typeof options?.defaultValue === 'string' ? key : key;

describe('AccountSecurityPanel', () => {
  test('mesh 下渲染改密 / TOTP / 通行密钥三块', () => {
    const html = render(MESH_MODE);
    expect(html).toContain('data-testid="account-security-panel"');
    expect(html).toContain('data-testid="security-change-password"');
    expect(html).toContain('data-testid="security-totp-set"');
    expect(html).toContain('data-testid="security-passkey-add"');
    expect(html).toContain('data-testid="security-full-reset"');
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

  test('全量重置默认不勾选，破坏性警告只在勾上之后出现', () => {
    const idle = renderPasswordSection();
    expect(idle).toContain('data-testid="security-full-reset"');
    expect(idle).toContain('auth.security.fullResetHint');
    expect(idle).not.toContain('data-testid="password-warning"');

    const checked = renderPasswordSection({ initialFullReset: true });
    expect(checked).toContain('data-testid="password-warning"');
    expect(checked).toContain('auth.security.changePasswordWarning');
  });

  test('开了 TOTP 才多一格重新登录用的验证码；勾上全量重置后不再需要', () => {
    expect(renderPasswordSection()).not.toContain('data-testid="security-relogin-code"');
    expect(renderPasswordSection({ totpEnabled: true })).toContain(
      'data-testid="security-relogin-code"'
    );
    expect(renderPasswordSection({ totpEnabled: true, initialFullReset: true })).not.toContain(
      'data-testid="security-relogin-code"'
    );
  });

  test('不再暴露整页路由（面板由 `?panel=security` 驱动）', () => {
    expect('accountSecurityRoute' in panelModule).toBe(false);
    expect('PageTitle' in panelModule).toBe(false);
  });
});

describe('passwordChangeFollowUp', () => {
  test('常规改密不清会话：拿新密码重建 delegation 再登录一次 entry', () => {
    expect(passwordChangeFollowUp({ fullReset: false, totpEnabled: false, totpCode: '' })).toBe(
      'resume-session'
    );
    expect(
      passwordChangeFollowUp({ fullReset: false, totpEnabled: true, totpCode: '123456' })
    ).toBe('resume-session');
  });

  test('开了 TOTP 却没给验证码：跳过重新登录，保留手上这份仍然有效的会话', () => {
    expect(passwordChangeFollowUp({ fullReset: false, totpEnabled: true, totpCode: '' })).toBe(
      'keep-session'
    );
    expect(passwordChangeFollowUp({ fullReset: false, totpEnabled: true, totpCode: '12' })).toBe(
      'keep-session'
    );
  });

  test('全量重置：服务端撤销了全部会话，本地必须清掉', () => {
    expect(passwordChangeFollowUp({ fullReset: true, totpEnabled: false, totpCode: '' })).toBe(
      'clear-session'
    );
    expect(passwordChangeFollowUp({ fullReset: true, totpEnabled: true, totpCode: '123456' })).toBe(
      'clear-session'
    );
  });
});

describe('securityActionErrorText', () => {
  test('hub 相关的码给出下一步该做什么', () => {
    expect(securityActionErrorText(t, 'HUB_TIMEOUT')).toBe('auth.security.primaryHubUnreachable');
    expect(securityActionErrorText(t, 'HUB_NOT_WRITER')).toBe('auth.security.switchToPrimaryHub');
    expect(securityActionErrorText(t, 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES')).toBe(
      'auth.security.nodesTooOld'
    );
  });

  test('其余码落回通用错误表', () => {
    expect(securityActionErrorText(t, 'KEY_LOG_FORK')).toBe('auth.errors.KEY_LOG_FORK');
  });
});

describe('finishPasswordChange', () => {
  /** 本次签进记录的值：epoch = 签名时的 E + 1，kdf 参数是新生成的那份。 */
  const SIGNED = {
    nextRootEpoch: 1,
    newKdfParams: {
      salt: 'BBBBBBBBBBBBBBBBBBBBBB',
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    },
  };
  /** 记录应用之后 `/api/auth/mode` 才会给出的那份参数。 */
  const SERVER_KDF = {
    salt: 'CCCCCCCCCCCCCCCCCCCCCC',
    memory_kib: 65536,
    iterations: 3,
    parallelism: 1,
  };

  /** `/api/auth/mode` 依次给出这些 rootEpoch（用完之后一直给最后一个）。 */
  function modeApi(epochs: number[], totpEnabled = false) {
    const state = { count: 0 };
    const api = {
      getMode: () => {
        const epoch = epochs[Math.min(state.count, epochs.length - 1)];
        state.count += 1;
        return Promise.resolve({
          ...MESH_MODE,
          rootEpoch: epoch,
          kdfParams: epoch === SIGNED.nextRootEpoch ? SERVER_KDF : MESH_MODE.kdfParams,
          totpEnabled,
        } as AuthModeResponse);
      },
    } as unknown as AuthApi;
    return { api, state };
  }

  type FinishInput = Parameters<typeof finishPasswordChange>[0];

  function finish(overrides: Partial<FinishInput> = {}) {
    return finishPasswordChange({
      api: modeApi([SIGNED.nextRootEpoch]).api,
      uid: 'user-1',
      nodeId: MESH_MODE.nodeId,
      password: 'new-secret',
      totpCode: '',
      totpEnabled: false,
      signed: SIGNED,
      follow: 'resume-session',
      t,
      // 单测不等真的 200ms 轮询间隔。
      sleep: () => Promise.resolve(),
      ...overrides,
    });
  }

  function resumedArgs() {
    return resumed.mock.calls[0][0] as {
      kdfParams: { salt: string };
      rootEpoch: number;
      hasTotp: boolean;
      totpCode?: string;
      entryNodeId: string;
    };
  }

  beforeEach(() => {
    cleared.mockClear();
    resumed.mockClear();
    resumed.mockImplementation(async () => ({ ok: true }));
  });

  test('常规改密成功后不清会话钥，只用新密码重新建立一次会话', async () => {
    const feedback = await finish();
    expect(cleared).not.toHaveBeenCalled();
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordKeepDone' });
  });

  test('重新登录没成功：保留旧会话，只给一行提示', async () => {
    resumed.mockImplementation(async () => ({ ok: false, code: 'BAD_SIGNATURE' }));
    const feedback = await finish();
    expect(cleared).not.toHaveBeenCalled();
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.sessionResumeFailed' });
  });

  test('重新登录过程中抛异常也只当作没接上，不报成改密失败', async () => {
    resumed.mockImplementation(() => Promise.reject(new Error('argon2 out of memory')));
    const feedback = await finish();
    expect(cleared).not.toHaveBeenCalled();
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.sessionResumeFailed' });
  });

  test('跳过重新登录时既不清会话也不发请求', async () => {
    const feedback = await finish({ follow: 'keep-session' });
    expect(cleared).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.sessionResumeSkipped' });
  });

  test('全量重置后清掉会话钥（含 IndexedDB 那份）', async () => {
    const feedback = await finish({ follow: 'clear-session' });
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(resumed).not.toHaveBeenCalled();
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordDone' });
  });

  test('mode 先给旧 epoch：poll 到新 epoch 后按服务端那份参数重建', async () => {
    const { api, state } = modeApi([0, 0, SIGNED.nextRootEpoch]);
    const feedback = await finish({ api });
    expect(state.count).toBe(3);
    expect(resumedArgs().kdfParams).toEqual(SERVER_KDF);
    expect(resumedArgs().rootEpoch).toBe(SIGNED.nextRootEpoch);
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordKeepDone' });
  });

  test('mode 一直停在旧 epoch：最多问 3 次，然后回落到签进记录的新参数', async () => {
    const { api, state } = modeApi([0]);
    await finish({ api });
    expect(state.count).toBe(3);
    // 绝不能拿 mode 给的旧 kdf 参数去重建——那把 delegation 一定验不过。
    expect(resumedArgs().kdfParams).toEqual(SIGNED.newKdfParams);
    expect(resumedArgs().rootEpoch).toBe(SIGNED.nextRootEpoch);
  });

  test('mode 整个读不到时也照样按签进记录的值重建', async () => {
    const api = {
      getMode: () => Promise.reject(new Error('offline')),
    } as unknown as AuthApi;
    const feedback = await finish({ api });
    expect(resumedArgs().kdfParams).toEqual(SIGNED.newKdfParams);
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordKeepDone' });
  });

  test('开了 TOTP：验证码原样转给重新登录，mode 没追上也知道还开着 TOTP', async () => {
    const { api } = modeApi([0]);
    await finish({ api, totpEnabled: true, totpCode: '123456' });
    expect(resumedArgs().totpCode).toBe('123456');
    expect(resumedArgs().hasTotp).toBe(true);
  });

  test('验证码不对：重新登录被拒，旧会话保留，只给一行提示', async () => {
    resumed.mockImplementation(async () => ({ ok: false, code: 'TOTP_INVALID' }));
    const feedback = await finish({ totpEnabled: true, totpCode: '000000' });
    expect(cleared).not.toHaveBeenCalled();
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.sessionResumeFailed' });
  });
});
