// 「登录限制」表单的静态渲染：预设卡片、自定义字段、只读 + 待升级节点清单。

import { describe, expect, test } from 'bun:test';
import { type LoginPolicyStatus, loginPolicyFromPreset } from '@vibeterm/shared/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import { loginLimitDraft, withPreset } from './login-limit-form';
import { LoginLimitForm, loginLimitErrorText } from './login-limit-section';

function status(patch: Partial<LoginPolicyStatus> = {}): LoginPolicyStatus {
  return {
    policy: loginPolicyFromPreset('standard'),
    source: 'keylog',
    writable: true,
    blockers: [],
    ...patch,
  };
}

function render(props: Partial<Parameters<typeof LoginLimitForm>[0]> = {}) {
  const current = props.status ?? status();
  return renderToStaticMarkup(
    <LoginLimitForm
      status={current}
      draft={loginLimitDraft(current.policy)}
      errors={{}}
      busy={false}
      dirty={false}
      feedback={null}
      onChange={() => undefined}
      onSave={() => undefined}
      {...props}
    />
  );
}

describe('LoginLimitForm', () => {
  test('four preset cards, current one checked, save disabled until dirty', () => {
    const html = render();
    for (const preset of ['relaxed', 'standard', 'strict', 'custom']) {
      expect(html).toContain(`data-testid="security-login-limit-preset-${preset}"`);
    }
    expect(html).toMatch(/checked="" value="standard"/);
    expect(html).toContain('auth.security.loginLimit.presetIp');
    expect(html).not.toContain('security-login-limit-custom');
    expect(html).toMatch(/disabled=""[^>]*data-testid="security-login-limit-save"/);
    expect(html).toContain('data-testid="security-login-limit-exempt"');
  });

  test('default source shows its note', () => {
    expect(render({ status: status({ source: 'default' }) })).toContain(
      'data-testid="security-login-limit-default"'
    );
  });

  test('custom preset reveals the numeric fields with errors', () => {
    const current = status();
    const html = render({
      status: current,
      draft: withPreset(loginLimitDraft(current.policy), 'custom'),
      errors: { ipLockMax: 'too short' },
      dirty: true,
    });
    expect(html).toContain('data-testid="security-login-limit-custom"');
    expect(html).toContain('data-testid="security-login-limit-ipFailThreshold"');
    expect(html).toContain('data-testid="security-login-limit-ipLockMax-unit"');
    expect(html).toContain('too short');
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="security-login-limit-save"/);
  });

  test('not writable: blockers listed and every control locked', () => {
    const html = render({
      status: status({
        writable: false,
        blockers: [
          { nodeId: 'n1', name: 'old-box', version: '2.9.0' },
          { nodeId: 'n2', name: 'mystery', version: null },
        ],
      }),
      dirty: true,
    });
    expect(html).toContain('data-testid="security-login-limit-blocked"');
    expect(html).toContain('old-box · v2.9.0');
    expect(html).toContain('auth.security.loginLimit.versionUnknown');
    expect(html).toMatch(/disabled=""[^>]*data-testid="security-login-limit-save"/);
  });
});

describe('loginLimitErrorText', () => {
  test('version gate gets its own sentence', () => {
    const t = (key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ''}`;
    expect(loginLimitErrorText(t, 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES')).toBe(
      'auth.security.loginLimit.blocked{"version":"2.10.0"}'
    );
  });
});
