// 账号安全面板（原 `/account/security` 整页）：三个区块的静态渲染与 standalone 下的空渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（副作用里的 passkey 列表请求不会跑）。

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AuthApi, AuthModeResponse } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

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

const pending = await import('@/node/relay-meta-key-pending');
const { renderToStaticMarkup } = await import('react-dom/server');
const panelModule = await import('./account-security-panel');
const AccountSecurityPanel = panelModule.default;
const {
  PasswordSection,
  finishPasswordChange,
  passwordChangeFollowUp,
  passwordInputError,
  securityActionErrorText,
  securityPanelView,
  withRelayAckNotice,
} = panelModule;
type SecurityActionFeedback = import('./account-security-panel').SecurityActionFeedback;

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
  overrides: Partial<AuthModeResponse> & {
    initialFullReset?: boolean;
    feedback?: SecurityActionFeedback | null;
  } = {}
): string {
  const { initialFullReset, feedback = null, ...modeOverrides } = overrides;
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
      feedback={feedback}
      publishFeedback={() => undefined}
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

  test('改密前就说明所有设备需重新登录、令牌 / 分享 / 授权会被撤销', () => {
    const html = renderPasswordSection();
    expect(html).toContain('data-testid="password-signout-hint"');
    expect(html).toContain('auth.security.changePasswordHint');
  });

  test('新密码旁给出一行生成建议', () => {
    const html = renderPasswordSection();
    expect(html).toContain('data-testid="security-new-password-hint"');
    expect(html).toContain('auth.security.newPasswordHint');
  });

  test('动作反馈来自面板级 state，按 section 摆回对应区块', () => {
    const ok: SecurityActionFeedback = {
      section: 'password',
      tone: 'ok',
      text: 'auth.security.changePasswordDone',
    };
    const html = renderPasswordSection({ feedback: ok });
    expect(html).toContain('data-testid="security-ok"');
    expect(html).toContain('auth.security.changePasswordDone');

    const notice = renderPasswordSection({
      feedback: { section: 'password', tone: 'notice', text: 'auth.security.changePasswordSignIn' },
    });
    expect(notice).toContain('data-testid="security-notice"');

    // 别的区块的反馈不该跑到改密这一块来。
    const other = renderPasswordSection({
      feedback: { section: 'totp', tone: 'ok', text: 'auth.security.totpDone' },
    });
    expect(other).not.toContain('data-testid="security-ok"');
    expect(renderPasswordSection()).not.toContain('data-testid="security-ok"');
  });

  test('不再暴露整页路由（面板由 `?panel=security` 驱动）', () => {
    expect('accountSecurityRoute' in panelModule).toBe(false);
    expect('PageTitle' in panelModule).toBe(false);
  });
});

describe('securityPanelView', () => {
  test('第一次还没拿到 mode 才摆 spinner', () => {
    expect(securityPanelView({ loading: true, mode: null })).toBe('pending');
    expect(securityPanelView({ loading: false, mode: null })).toBe('empty');
  });

  test('改密后的刷新期间继续渲染内容：子树不卸载，反馈才留得住', () => {
    // 这正是「改密成功后什么都没发生」的成因：reload() 把 loading 翻回 true，
    // 旧实现这时回落到 spinner，刚写上的 security-ok 随子树一起消失。
    expect(securityPanelView({ loading: true, mode: MESH_MODE })).toBe('content');
    expect(securityPanelView({ loading: false, mode: MESH_MODE })).toBe('content');
  });

  test('standalone 无论加载与否都不渲染', () => {
    expect(securityPanelView({ loading: false, mode: { ...MESH_MODE, mode: 'none' } })).toBe(
      'empty'
    );
    expect(securityPanelView({ loading: true, mode: { ...MESH_MODE, mode: 'none' } })).toBe(
      'empty'
    );
  });
});

describe('passwordInputError', () => {
  const t = (key: string) => key;
  const check = (
    newPassword: string,
    over: { username?: string | null; confirm?: string; oldPassword?: string } = {}
  ) =>
    passwordInputError(
      t,
      {
        oldPassword: over.oldPassword ?? 'old',
        newPassword,
        confirm: over.confirm ?? newPassword,
      },
      over.username === undefined ? 'alice' : over.username
    );

  test('空值与两次不一致先于强度检查', () => {
    expect(check('x', { oldPassword: '' })).toBe('auth.security.passwordRequired');
    expect(check('')).toBe('auth.security.passwordRequired');
    expect(check('xK9#mP2$vL7@qR4n', { confirm: 'other' })).toBe('auth.security.passwordMismatch');
  });

  test('过短、过于简单、含用户名都拒绝', () => {
    expect(check('new-secret')).toBe('auth.security.passwordTooShort');
    expect(check('123456789012')).toBe('auth.security.passwordTooSimple');
    expect(check('xK9#alice#mP2$vL')).toBe('auth.security.passwordTooSimple');
    expect(check('password1234', { username: null })).toBe('auth.security.passwordTooSimple');
  });

  test('足够强的密码放行，用户名缺失时不做包含检查', () => {
    expect(check('xK9#mP2$vL7@qR4n')).toBeNull();
    expect(check('xK9#alice#mP2$vL', { username: null })).toBeNull();
  });
});

describe('passwordChangeFollowUp', () => {
  test('改密撤销了全部会话：拿内存里的新密码重建 delegation 再登录一次 entry', () => {
    expect(passwordChangeFollowUp({ fullReset: false, totpEnabled: false, totpCode: '' })).toBe(
      'resume-session'
    );
    expect(
      passwordChangeFollowUp({ fullReset: false, totpEnabled: true, totpCode: '123456' })
    ).toBe('resume-session');
  });

  test('开了 TOTP 却没给验证码：静默登录做不了，直接回登录页', () => {
    expect(passwordChangeFollowUp({ fullReset: false, totpEnabled: true, totpCode: '' })).toBe(
      'sign-in'
    );
    expect(passwordChangeFollowUp({ fullReset: false, totpEnabled: true, totpCode: '12' })).toBe(
      'sign-in'
    );
  });

  test('全量重置同样静默接回：TOTP 已被清掉，不再要验证码', () => {
    expect(passwordChangeFollowUp({ fullReset: true, totpEnabled: false, totpCode: '' })).toBe(
      'resume-session'
    );
    expect(passwordChangeFollowUp({ fullReset: true, totpEnabled: true, totpCode: '' })).toBe(
      'resume-session'
    );
  });
});

describe('securityActionErrorText', () => {
  test('节点过旧单独给一句，其余落回通用错误表', () => {
    expect(securityActionErrorText(t, 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES')).toBe(
      'auth.security.nodesTooOld'
    );
    expect(securityActionErrorText(t, 'HUB_TIMEOUT')).toBe('auth.errors.HUB_TIMEOUT');
    expect(securityActionErrorText(t, 'HUB_NOT_WRITER')).toBe('auth.errors.HUB_NOT_WRITER');
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

  const toLogin = mock(() => undefined);

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
      toLogin,
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
    toLogin.mockClear();
    resumed.mockClear();
    resumed.mockImplementation(async () => ({ ok: true }));
  });

  test('改密成功后静默接回会话：用新密码重建一次，不清会话钥、不回登录页', async () => {
    const feedback = await finish();
    expect(cleared).not.toHaveBeenCalled();
    expect(toLogin).not.toHaveBeenCalled();
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordDone' });
  });

  test('重新登录没成功：旧会话已被服务端撤销，清掉本地那份并回登录页', async () => {
    resumed.mockImplementation(async () => ({ ok: false, code: 'BAD_SIGNATURE' }));
    const feedback = await finish();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(toLogin).toHaveBeenCalledTimes(1);
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.changePasswordSignIn' });
  });

  test('重新登录过程中抛异常也只当作没接上：同样清会话回登录页，不报成改密失败', async () => {
    resumed.mockImplementation(() => Promise.reject(new Error('argon2 out of memory')));
    const feedback = await finish();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(toLogin).toHaveBeenCalledTimes(1);
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.changePasswordSignIn' });
  });

  test('没给验证码无从静默登录：不发请求，清会话回登录页', async () => {
    const feedback = await finish({ follow: 'sign-in' });
    expect(resumed).not.toHaveBeenCalled();
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(toLogin).toHaveBeenCalledTimes(1);
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.changePasswordSignIn' });
  });

  test('mode 先给旧 epoch：poll 到新 epoch 后按服务端那份参数重建', async () => {
    const { api, state } = modeApi([0, 0, SIGNED.nextRootEpoch]);
    const feedback = await finish({ api });
    expect(state.count).toBe(3);
    expect(resumedArgs().kdfParams).toEqual(SERVER_KDF);
    expect(resumedArgs().rootEpoch).toBe(SIGNED.nextRootEpoch);
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordDone' });
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
    expect(feedback).toEqual({ tone: 'ok', text: 'auth.security.changePasswordDone' });
  });

  test('开了 TOTP：验证码原样转给重新登录，mode 没追上也知道还开着 TOTP', async () => {
    const { api } = modeApi([0]);
    await finish({ api, totpEnabled: true, totpCode: '123456' });
    expect(resumedArgs().totpCode).toBe('123456');
    expect(resumedArgs().hasTotp).toBe(true);
  });

  test('验证码不对：重新登录被拒，清会话回登录页重新输入', async () => {
    resumed.mockImplementation(async () => ({ ok: false, code: 'TOTP_INVALID' }));
    const feedback = await finish({ totpEnabled: true, totpCode: '000000' });
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(toLogin).toHaveBeenCalledTimes(1);
    expect(feedback).toEqual({ tone: 'notice', text: 'auth.security.changePasswordSignIn' });
  });
});

describe('finishPasswordChange：重新登录后还中继欠账', () => {
  const CHEAP_SIGNED = {
    nextRootEpoch: 1,
    newKdfParams: {
      salt: 'BBBBBBBBBBBBBBBBBBBBBB',
      memory_kib: 64,
      iterations: 1,
      parallelism: 1,
    },
  };
  const QUEUED = { type: 'meta-key' as const, bytes: 'YWJj', sig: 'ZGVm' };

  function relayFixture(options: { appendResult?: unknown; uploadFails?: boolean } = {}) {
    const appended: { bytes: string; sig: string }[] = [];
    const uploads: { root_epoch: number }[] = [];
    const api = {
      getMode: () =>
        Promise.resolve({
          ...MESH_MODE,
          rootEpoch: CHEAP_SIGNED.nextRootEpoch,
          kdfParams: CHEAP_SIGNED.newKdfParams,
        }),
      keyLogHead: () =>
        Promise.resolve({
          seq: 6,
          hash: encodeBase64url(new Uint8Array(32).fill(7)),
          rootEpoch: CHEAP_SIGNED.nextRootEpoch,
        }),
      appendKeyLog: (body: { bytes: string; sig: string }) => {
        appended.push(body);
        return Promise.resolve(options.appendResult ?? { ok: true, hubAck: true });
      },
    } as unknown as AuthApi;
    const relayApi = {
      joinMaterial: () =>
        Promise.resolve({
          logKey: encodeBase64url(new Uint8Array(32).fill(0x11)),
          relays: [
            {
              url: 'https://r.example',
              tenantId: 'ab'.repeat(16),
              token: encodeBase64url(new Uint8Array(32).fill(0x22)),
            },
          ],
        }),
      uploadPack: (body: { root_epoch: number }) => {
        if (options.uploadFails) return Promise.reject(new Error('offline'));
        uploads.push(body);
        return Promise.resolve({ ok: true });
      },
    } as unknown as RelayTenantApi;
    return { api, relayApi, appended, uploads };
  }

  function finishRelay(fixture: ReturnType<typeof relayFixture>) {
    return finishPasswordChange({
      api: fixture.api,
      uid: 'user-1',
      nodeId: MESH_MODE.nodeId,
      password: 'new-secret-password',
      totpCode: '',
      totpEnabled: false,
      signed: CHEAP_SIGNED,
      follow: 'resume-session',
      relay: { relayApi: fixture.relayApi },
      toLogin: () => undefined,
      t,
      sleep: () => Promise.resolve(),
    });
  }

  beforeEach(() => {
    cleared.mockClear();
    resumed.mockClear();
    resumed.mockImplementation(async () => ({ ok: true }));
    pending.clearPendingMetaKeysForTest();
    pending.clearRelayPackDebtForTest();
    pending.rememberPendingMetaKey({
      id: 'rotate-root',
      reason: 'rotateRoot',
      op: { op: 'rotate' },
      record: QUEUED,
    });
    pending.rememberRelayPackDebt();
  });

  test('会话接回后立刻送预签的 meta-key、再按新 epoch 重封密封包，欠账全部销掉', async () => {
    const fixture = relayFixture();
    const feedback = await finishRelay(fixture);
    expect(fixture.appended).toEqual([{ bytes: QUEUED.bytes, sig: QUEUED.sig }]);
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0].root_epoch).toBe(CHEAP_SIGNED.nextRootEpoch);
    expect(pending.listPendingMetaKeys()).toHaveLength(0);
    expect(pending.relayPackDebt()).toBe(false);
    expect(feedback).toEqual({
      tone: 'ok',
      text: 'auth.security.changePasswordDone',
      metaKey: { ok: true },
    });
  });

  test('密封包没送上去：meta-key 照样送出，密封包欠账留着等节点页重试', async () => {
    const fixture = relayFixture({ uploadFails: true });
    const feedback = await finishRelay(fixture);
    expect(fixture.appended).toHaveLength(1);
    expect(pending.listPendingMetaKeys()).toHaveLength(0);
    expect(pending.relayPackDebt()).toBe(true);
    expect(feedback.metaKey).toEqual({ ok: true });
  });

  test('meta-key 被拒：欠账与失败结论都留着，密封包仍然照常重封', async () => {
    const fixture = relayFixture({ appendResult: { ok: false, code: 'seq_gap' } });
    const feedback = await finishRelay(fixture);
    expect(feedback.metaKey).toEqual({ ok: false, code: 'seq_gap' });
    expect(pending.listPendingMetaKeys()).toHaveLength(1);
    expect(fixture.uploads).toHaveLength(1);
    expect(pending.relayPackDebt()).toBe(false);
  });

  test('没接回会话：一个中继请求都不发，欠账原样留着', async () => {
    resumed.mockImplementation(async () => ({ ok: false, code: 'BAD_SIGNATURE' }));
    const fixture = relayFixture();
    await finishRelay(fixture);
    expect(fixture.appended).toHaveLength(0);
    expect(fixture.uploads).toHaveLength(0);
    expect(pending.listPendingMetaKeys()).toHaveLength(1);
    expect(pending.relayPackDebt()).toBe(true);
  });
});

describe('withRelayAckNotice', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key;
  const done = { tone: 'ok', text: '已修改密码。' } as const;

  test('中继确认过（或不在中继模式）时原样返回', () => {
    expect(withRelayAckNotice(done, { relayAck: true }, t)).toEqual(done);
    expect(withRelayAckNotice(done, {}, t)).toEqual(done);
  });

  test('中继没确认时降级成提示并补一句告警', () => {
    const feedback = withRelayAckNotice(done, { relayAck: false, relayError: 'offline' }, t);
    expect(feedback.tone).toBe('notice');
    expect(feedback.text).toStartWith('已修改密码。 relay.tenant.relayAck.warning:');
    expect(feedback.text).toContain('relay.tenant.relayAck.errors.offline');
  });
});
