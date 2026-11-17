// 「登录命令」对话框：状态机（用假的签发模块 + 注入定时器）与各视图的静态渲染。
// 无 DOM 测试环境，视图用 react-dom/server 渲染（Base UI 对话框走 portal，只能测内部视图）。

import { describe, expect, test } from 'bun:test';
import type { LoginCodeContext, LoginCodeNodeState } from '@/auth/login-code-issue';
import type { NodeRow } from '@/node/mesh-nodes';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { ReactElement, ReactNode } from 'react';
import { Children } from 'react';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { createLoginCodeController, hasPendingNodes } = await import('./login-code-controller');
const { LoginCodeForm } = await import('./login-code-form');
const { LoginCodeResultView, buildResultRows } = await import('./login-code-result');
const { buildProof, draftResetForFailure, initialDraft } = await import('./login-code-draft');
const { formatCountdown, loginCodeErrorText, loginCodeReasonText } = await import(
  './login-code-text'
);
const { loginCodeIneligibleReason, loginCodeMenuTitle } = await import('./login-code-eligibility');
const { NodeMoreMenuList } = await import('./node-more-menu');
const { LoginCodeDialogHost } = await import('./login-code-dialog');
const { LoginCodeButton } = await import('./login-code-button');
const { methodText } = await import('../login-history/login-history-format');

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

const NOW = 1_700_000_000_000;
const COMMAND = 'vibeterm login --code vtl1_example';

function context(
  proofKinds: LoginCodeContext['proofKinds'],
  totpEnabled = false
): LoginCodeContext {
  return { mode: {} as never, selfMeshId: 'a'.repeat(32), proofKinds, totpEnabled };
}

const TARGET_A = { meshId: 'node-a', runtimeId: 'self', name: 'alpha', publicKey: 'pk-a' };
const TARGET_B = { meshId: 'node-b', runtimeId: 'node-b', name: 'bravo', publicKey: 'pk-b' };

interface FakeOptions {
  issue?: (input: { proof: { kind: string } }) => unknown;
  polls?: Array<Record<string, LoginCodeNodeState>>;
}

function fakeModule(options: FakeOptions = {}) {
  const calls = { issue: 0, poll: 0, revoke: 0, dispose: 0 };
  const handle = { command: COMMAND, expiresAt: NOW + 600_000, meshIds: ['node-a', 'node-b'] };
  const polls = [...(options.polls ?? [])];
  const mod = {
    loadLoginCodeContext: async () => context(['totp', 'passkey']),
    planLoginCodeTargets: () => ({ targets: [TARGET_A, TARGET_B], skipped: [] }),
    issueLoginCode: async (input: { proof: { kind: string } }) => {
      calls.issue += 1;
      if (options.issue) return options.issue(input);
      return {
        ok: true,
        handle,
        nodes: [
          { meshId: 'node-a', name: 'alpha', ok: true, expiresAt: handle.expiresAt },
          { meshId: 'node-b', name: 'bravo', ok: true, expiresAt: handle.expiresAt },
        ],
      };
    },
    pollLoginCodeStates: async () => {
      calls.poll += 1;
      return polls.shift() ?? { 'node-a': 'pending', 'node-b': 'pending' };
    },
    revokeLoginCode: async () => {
      calls.revoke += 1;
    },
    disposeLoginCode: () => {
      calls.dispose += 1;
    },
  };
  return { mod: mod as never, calls, handle };
}

/** 可手动触发的定时器：poll 的下一拍由测试显式推进。 */
function manualTimers() {
  const pending: Array<() => void> = [];
  return {
    setTimer: (fn: () => void) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimer: () => {
      pending.length = 0;
    },
    pending,
    fire: async () => {
      const fn = pending.shift();
      fn?.();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function setup(options: FakeOptions = {}) {
  const fake = fakeModule(options);
  const timers = manualTimers();
  const controller = createLoginCodeController({
    loadModule: async () => fake.mod,
    now: () => NOW,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { ...fake, timers, controller };
}

const GENERATE_INPUT = {
  targets: [TARGET_A, TARGET_B],
  skipped: [{ meshId: 'node-c', name: 'charlie', reason: 'offline' as const }],
  proof: { kind: 'totp' as const, code: '123456' },
};

function renderForm(ctx: LoginCodeContext, scope: 'all' | 'one' = 'all'): string {
  const draft = { ...initialDraft('all'), scope };
  return renderToStaticMarkup(
    <LoginCodeForm
      context={ctx}
      draft={draft}
      onDraft={() => undefined}
      options={[]}
      nodeId={null}
      targetCount={2}
      skippedCount={1}
      busy={false}
      focusSeq={0}
    />
  );
}

describe('验证方式随 proofKinds 渲染', () => {
  test('验证码与通行密钥都有：出现切换，默认第一项是验证码输入', () => {
    const html = renderForm(context(['totp', 'passkey']));
    expect(html).toContain('data-testid="login-code-proof"');
    expect(html).toContain('nodes.loginCode.proof.passkey');
    expect(html).toContain('data-testid="login-code-totp"');
    expect(html).not.toContain('login-code-passkey-hint');
  });

  test('只有验证码：不出现切换', () => {
    const html = renderForm(context(['totp']));
    expect(html).not.toContain('data-testid="login-code-proof"');
    expect(html).toContain('data-testid="login-code-totp"');
  });

  test('只有通行密钥：只给提示，没有输入框', () => {
    const html = renderForm(context(['passkey']));
    expect(html).toContain('login-code-passkey-hint');
    expect(html).toContain('nodes.loginCode.proof.passkeyHint');
    expect(html).not.toContain('data-testid="login-code-totp"');
  });

  test('密码兜底：开了 TOTP 才多一格验证码', () => {
    const withTotp = renderForm(context(['password'], true));
    expect(withTotp).toContain('type="password"');
    expect(withTotp).toContain('autoComplete="current-password"');
    expect(withTotp).toContain('data-testid="login-code-password-totp"');
    const without = renderForm(context(['password'], false));
    expect(without).toContain('data-testid="login-code-password"');
    expect(without).not.toContain('login-code-password-totp');
  });

  test('全部节点：显示台数与跳过台数', () => {
    const html = renderForm(context(['totp']));
    // 无 i18n 实例时 t 只回键名（不插值）。
    expect(html).toContain('nodes.loginCode.target.count');
    expect(html).toContain('nodes.loginCode.target.skipped');
  });

  test('buildProof：输入完整前不可生成', () => {
    const both = context(['totp', 'passkey']);
    const draft = initialDraft('all');
    expect(buildProof(both, draft)).toBeNull();
    expect(buildProof(both, { ...draft, totp: '123456' })).toEqual({
      kind: 'totp',
      code: '123456',
    });
    expect(buildProof(both, { ...draft, proofKind: 'passkey' })).toEqual({ kind: 'passkey' });
    const pw = context(['password'], true);
    expect(buildProof(pw, { ...draft, password: 'pw' })).toBeNull();
    expect(buildProof(pw, { ...draft, password: 'pw', passwordTotp: '654321' })).toEqual({
      kind: 'password',
      password: 'pw',
      totpCode: '654321',
    });
  });
});

describe('生成 → 结果', () => {
  test('加载上下文后可生成；结果带命令与各节点待使用状态', async () => {
    const { controller, calls } = setup();
    await controller.load();
    expect(controller.getState().phase).toBe('ready');
    const res = await controller.generate(GENERATE_INPUT);
    expect(res?.ok).toBe(true);
    const state = controller.getState();
    expect(state.phase).toBe('result');
    expect(state.result?.states).toEqual({ 'node-a': 'pending', 'node-b': 'pending' });
    expect(calls.issue).toBe(1);

    const html = renderToStaticMarkup(
      <LoginCodeResultView result={state.result as never} now={NOW + 65_000} />
    );
    expect(html).toContain(COMMAND);
    expect(html).toContain('data-testid="login-code-command-copy"');
    expect(html).toContain('nodes.loginCode.result.remaining');
    expect(html).toContain('nodes.loginCode.status.pending');
    // 跳过的节点带原因列出
    expect(html).toContain('charlie');
    expect(html).toContain('nodes.loginCode.reason.offline');
  });

  test('加载失败可重试', async () => {
    let attempts = 0;
    const fake = fakeModule();
    const controller = createLoginCodeController({
      loadModule: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('chunk failed');
        return fake.mod;
      },
    });
    await controller.load();
    expect(controller.getState().loadFailed).toBe(true);
    await controller.load();
    expect(controller.getState().loadFailed).toBe(false);
    expect(controller.getState().phase).toBe('ready');
  });

  test('TOTP_INVALID：停在表单、带错误码，验证码字段被清空', async () => {
    const { controller } = setup({
      issue: () => ({ ok: false, code: 'TOTP_INVALID', nodes: [] }),
    });
    await controller.load();
    const res = await controller.generate(GENERATE_INPUT);
    expect(res).toMatchObject({ ok: false, code: 'TOTP_INVALID' });
    expect(controller.getState().phase).toBe('ready');
    expect(controller.getState().error).toEqual({ code: 'TOTP_INVALID', retryAfterMs: undefined });
    expect(draftResetForFailure('TOTP_INVALID')).toEqual({ totp: '', passwordTotp: '' });
    expect(draftResetForFailure('TOTP_ALREADY_USED')).not.toBeNull();
    expect(draftResetForFailure('NETWORK_ERROR')).toBeNull();
    controller.clearError();
    expect(controller.getState().error).toBeNull();
  });

  test('失败码映射到中文文案键；限流带剩余时长', () => {
    expect(loginCodeErrorText(t, 'TOTP_INVALID')).toBe('nodes.loginCode.errors.TOTP_INVALID');
    expect(loginCodeErrorText(t, 'PASSKEY_INVALID')).toBe('nodes.loginCode.errors.PASSKEY_FAILED');
    expect(loginCodeErrorText(t, 'PASSKEY_REQUIRED')).toBe('nodes.loginCode.errors.PASSKEY_FAILED');
    expect(loginCodeErrorText(t, 'RATE_LIMITED', 90_000)).toBe(
      'nodes.loginCode.errors.rateLimited:{"time":"auth.duration.minutes:{\\"n\\":2}"}'
    );
    expect(loginCodeErrorText(t, 'WHATEVER')).toBe(
      'nodes.loginCode.errors.unknown:{"code":"WHATEVER"}'
    );
    expect(loginCodeReasonText(t, 'OUTDATED')).toBe('nodes.loginCode.reason.outdated');
    expect(loginCodeReasonText(t, 'NETWORK_ERROR')).toBe('nodes.loginCode.reason.unreachable');
    expect(formatCountdown(599_001)).toBe('10:00');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});

describe('轮询', () => {
  test('每拍刷新状态；全部使用后不再排下一拍；unknown 保留旧值', async () => {
    const { controller, timers, calls } = setup({
      polls: [
        { 'node-a': 'used', 'node-b': 'unknown' },
        { 'node-a': 'used', 'node-b': 'used' },
      ],
    });
    await controller.load();
    await controller.generate(GENERATE_INPUT);
    expect(timers.pending).toHaveLength(1);

    await timers.fire();
    expect(calls.poll).toBe(1);
    expect(controller.getState().result?.states).toEqual({ 'node-a': 'used', 'node-b': 'pending' });
    expect(hasPendingNodes(controller.getState().result as never)).toBe(true);
    expect(timers.pending).toHaveLength(1);

    await timers.fire();
    expect(controller.getState().result?.states).toEqual({ 'node-a': 'used', 'node-b': 'used' });
    expect(timers.pending).toHaveLength(0);

    const html = renderToStaticMarkup(
      <LoginCodeResultView result={controller.getState().result as never} now={NOW} />
    );
    expect(html).toContain('nodes.loginCode.status.used');
    expect(html).not.toContain('nodes.loginCode.status.pending');
  });

  test('过期后仍待使用的节点显示已过期，且不再排轮询', async () => {
    const fake = fakeModule();
    const timers = manualTimers();
    const controller = createLoginCodeController({
      loadModule: async () => fake.mod,
      now: () => fake.handle.expiresAt + 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await controller.load();
    await controller.generate(GENERATE_INPUT);
    expect(timers.pending).toHaveLength(0);
    const rows = buildResultRows(controller.getState().result as never, true);
    expect(rows.filter((row) => row.kind === 'state' && row.state === 'expired')).toHaveLength(2);
  });
});

describe('作废与关闭', () => {
  test('作废：调用 revoke 后立即补一次轮询', async () => {
    const { controller, calls, timers } = setup({
      polls: [{ 'node-a': 'revoked', 'node-b': 'revoked' }],
    });
    await controller.load();
    await controller.generate(GENERATE_INPUT);
    await controller.revoke();
    expect(calls.revoke).toBe(1);
    expect(calls.poll).toBe(1);
    expect(controller.getState().result?.states).toEqual({
      'node-a': 'revoked',
      'node-b': 'revoked',
    });
    expect(controller.getState().result?.revoking).toBe(false);
    expect(hasPendingNodes(controller.getState().result as never)).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });

  test('关闭：释放句柄并复位，之后不再轮询', async () => {
    const { controller, calls, timers } = setup();
    await controller.load();
    await controller.generate(GENERATE_INPUT);
    controller.dispose();
    expect(calls.dispose).toBe(1);
    expect(controller.getState().result).toBeNull();
    expect(timers.pending).toHaveLength(0);
    await controller.poll();
    expect(calls.poll).toBe(0);
  });

  test('签发在途时关闭：返回的句柄立刻销毁', async () => {
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { controller, calls, handle } = setup({
      issue: async () => {
        await gate;
        return { ok: true, handle, nodes: [] };
      },
    });
    await controller.load();
    const pending = controller.generate(GENERATE_INPUT);
    controller.dispose();
    release(null);
    await pending;
    expect(calls.dispose).toBe(1);
    expect(controller.getState().result).toBeNull();
  });
});

describe('行内菜单与登录历史', () => {
  const row = (overrides: Partial<NodeRow>) =>
    ({ isSelf: false, online: true, version: '2.17.0', ...overrides }) as Pick<
      NodeRow,
      'isSelf' | 'online' | 'version'
    >;

  test('离线、版本过低（含缺版本）禁用；本机与达标版本可用', () => {
    expect(loginCodeIneligibleReason(row({ online: false }))).toBe('offline');
    expect(loginCodeIneligibleReason(row({ version: '2.16.9' }))).toBe('outdated');
    expect(loginCodeIneligibleReason(row({ version: null }))).toBe('outdated');
    expect(loginCodeIneligibleReason(row({}))).toBeNull();
    expect(loginCodeIneligibleReason(row({ version: '2.18.0' }))).toBeNull();
    expect(loginCodeIneligibleReason(row({ isSelf: true, online: false }))).toBeNull();
    expect(loginCodeMenuTitle('outdated', t)).toBe(
      'nodes.loginCode.menuOutdated:{"version":"2.17.0"}'
    );
    expect(loginCodeMenuTitle(null, t)).toBeUndefined();
  });

  test('菜单项：版本过低时禁用并带提示；不传回调则不出现', () => {
    const base = {
      row: { id: 'n1' },
      paused: false,
      pauseDisabled: false,
      memoryDisabled: false,
      labels: { detail: '详情', memory: '内存限额', pause: '暂停', loginCode: '登录命令' },
      onDetail: () => undefined,
      onMemory: () => undefined,
      onPause: () => undefined,
    };
    const itemsOf = (props: Parameters<typeof NodeMoreMenuList>[0]) => {
      const list = NodeMoreMenuList(props) as ReactElement<{ children?: ReactNode }>;
      return Children.toArray(list.props.children) as ReactElement<{
        'data-testid'?: string;
        disabled?: boolean;
        title?: string;
      }>[];
    };
    const blocked = itemsOf({
      ...base,
      loginCodeDisabled: true,
      loginCodeTitle: 'nodes.loginCode.menuOutdated',
      onLoginCode: () => undefined,
    });
    const item = blocked.find((entry) => entry.props['data-testid'] === 'nodes-login-code-n1');
    expect(item?.props.disabled).toBe(true);
    expect(item?.props.title).toBe('nodes.loginCode.menuOutdated');
    expect(itemsOf(base).map((entry) => entry.props['data-testid'])).not.toContain(
      'nodes-login-code-n1'
    );
  });

  test('登录历史：经登录命令兑换的会话标「登录命令」', () => {
    expect(methodText(t, { method: 'root', second: 'code' })).toBe(
      'settings.loginHistory.method.code'
    );
    expect(methodText(t, { method: 'passkey', second: 'code' })).toBe(
      'settings.loginHistory.method.code'
    );
  });
});

describe('入口', () => {
  test('没有打开请求时对话框宿主不渲染；卡头按钮带「登录命令」标题键', () => {
    expect(renderToStaticMarkup(<LoginCodeDialogHost />)).toBe('');
    const html = renderToStaticMarkup(<LoginCodeButton />);
    expect(html).toContain('data-testid="nodes-login-code"');
    expect(html).toContain('nodes.loginCode.title');
  });
});
