// 向导的静态渲染：路径选择、预填规则、校验文案的呈现。

import { describe, expect, test } from 'bun:test';
import type { LocalStatusResponse } from '@vibeterm/api-client/local/types';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { SetupWizard } = await import('./setup-wizard');
const { BecomeRelayForm } = await import('./become-relay-form');
const { JoinRelayForm } = await import('./join-relay-form');
const { FormField } = await import('./form-parts');

function status(overrides: Partial<LocalStatusResponse> = {}): LocalStatusResponse {
  return {
    role: 'standalone',
    nodeEnv: 'production',
    direct: {
      supported: true,
      installed: false,
      enabled: true,
      capable: false,
      version: null,
      platform: 'darwin-arm64',
    },
    tls: { mode: 'none', listenerRunning: false, tlsPort: null },
    domainAccess: { allowed: true, viaDomain: false, hosts: [] },
    relay: null,
    ...overrides,
  };
}

describe('SetupWizard', () => {
  test('localStatus 还没到时只渲染占位', () => {
    const html = renderToStaticMarkup(<SetupWizard localStatus={null} />);
    expect(html).toContain('data-testid="setup-wizard-loading"');
    expect(html).not.toContain('data-testid="setup-wizard"');
  });

  test('已经在 mesh 里的实例不渲染向导', () => {
    expect(renderToStaticMarkup(<SetupWizard localStatus={status({ role: 'node' })} />)).toBe('');
    expect(renderToStaticMarkup(<SetupWizard localStatus={status({ role: 'relay,node' })} />)).toBe(
      ''
    );
  });

  test('standalone 渲染两条路径且默认都未选中，不渲染任何表单', () => {
    const html = renderToStaticMarkup(<SetupWizard localStatus={status()} />);
    expect(html).toContain('data-testid="setup-wizard"');
    for (const path of ['join-relay', 'become-relay']) {
      expect(html).toContain(`data-testid="setup-path-${path}" data-selected="false"`);
    }
    expect(html).not.toContain('data-testid="setup-path-become-hub"');
    expect(html).not.toContain('data-testid="setup-path-join-hub"');
    expect(html).not.toContain('data-testid="setup-become-relay-form"');
    expect(html).not.toContain('data-testid="setup-join-relay-form"');
  });

  test('选中 join-relay 时渲染加入中继表单', () => {
    const html = renderToStaticMarkup(
      <SetupWizard localStatus={status()} initialPath="join-relay" hostname="studio" />
    );
    expect(html).toContain('data-testid="setup-join-relay-form"');
    expect(html).not.toContain('data-testid="setup-become-relay-form"');
    expect(html).toContain('data-testid="setup-path-join-relay" data-selected="true"');
  });

  test('选中 become-relay 时渲染中继表单', () => {
    const html = renderToStaticMarkup(
      <SetupWizard localStatus={status()} initialPath="become-relay" origin={null} />
    );
    expect(html).toContain('data-testid="setup-become-relay-form"');
    expect(html).toContain('data-testid="setup-path-become-relay" data-selected="true"');
    expect(html).toContain('id="setup-relay-username"');
    expect(html).not.toContain('data-testid="setup-relay-pure-notice"');
  });

  test('跨重启记号恢复出来的「纯中继」赢过默认的「中继兼节点」', () => {
    const html = renderToStaticMarkup(
      <SetupWizard
        localStatus={status()}
        initialPath="become-relay"
        initialRelayRole="relay"
        origin={null}
      />
    );
    expect(html).toContain('data-testid="setup-relay-pure-notice"');
    expect(html).not.toContain('id="setup-relay-username"');
  });
});

describe('BecomeRelayForm', () => {
  test('默认中继兼节点：口令字段带生成按钮，账号三件与直连开关都在', () => {
    const html = renderToStaticMarkup(<BecomeRelayForm localStatus={status()} origin={null} />);
    expect(html).toContain('id="setup-relay-public-url"');
    expect(html).toContain('data-testid="setup-relay-password-generate"');
    expect(html).toContain('data-testid="setup-relay-also-node"');
    expect(html).toContain('id="setup-relay-username"');
    expect(html).toContain('data-testid="setup-relay-account-password-generate"');
    expect(html).toContain('id="setup-relay-confirm-password"');
    expect(html).toContain('data-testid="setup-relay-direct-enable"');
    expect(html).toContain('data-testid="setup-become-relay-submit"');
    expect(html).not.toContain('data-testid="setup-relay-pure-notice"');
  });

  test('纯中继：不建账号，改为提示网页会消失', () => {
    const html = renderToStaticMarkup(
      <BecomeRelayForm localStatus={status()} origin={null} initialRole="relay" />
    );
    expect(html).toContain('data-testid="setup-relay-pure-notice"');
    expect(html).toContain('nodes.setup.becomeRelay.pureNotice');
    expect(html).not.toContain('id="setup-relay-username"');
    expect(html).not.toContain('id="setup-relay-confirm-password"');
  });

  test('纯中继的确认框默认关着，提交时才弹', () => {
    const html = renderToStaticMarkup(
      <BecomeRelayForm localStatus={status()} origin={null} initialRole="relay" />
    );
    expect(html).not.toContain('data-testid="setup-pure-relay-confirm"');
  });

  test('直连提示用中继版文案', () => {
    const html = renderToStaticMarkup(<BecomeRelayForm localStatus={status()} origin={null} />);
    expect(html).toContain('nodes.setup.fields.directEnableRelayHint');
  });

  test('https origin 预填公网地址；production 下 http origin 不预填', () => {
    expect(
      renderToStaticMarkup(
        <BecomeRelayForm localStatus={status()} origin="https://relay.example.com" />
      )
    ).toContain('value="https://relay.example.com"');
    expect(
      renderToStaticMarkup(
        <BecomeRelayForm localStatus={status()} origin="http://localhost:19663" />
      )
    ).not.toContain('value="http://localhost:19663"');
  });
});

describe('JoinRelayForm', () => {
  test('四个必填字段与提交按钮；CA 指纹收在高级里，默认不渲染', () => {
    const html = renderToStaticMarkup(<JoinRelayForm localStatus={status()} hostname="studio" />);
    expect(html).toContain('data-testid="setup-join-relay-form"');
    expect(html).toContain('id="setup-relay-url"');
    expect(html).toContain('data-testid="setup-relay-tenant-id-input"');
    expect(html).toContain('data-testid="setup-relay-join-password-input"');
    expect(html).toContain('value="studio"');
    expect(html).toContain('data-testid="setup-relay-advanced-toggle"');
    expect(html).not.toContain('data-testid="setup-relay-ca-fingerprint-input"');
    expect(html).toContain('data-testid="setup-join-relay-submit"');
    expect(html).toContain('data-testid="setup-relay-join-direct-enable"');
  });

  test('直连提示用中继版文案', () => {
    const html = renderToStaticMarkup(<JoinRelayForm localStatus={status()} hostname="studio" />);
    expect(html).toContain('nodes.setup.fields.directEnableRelayHint');
  });
});

describe('FormField', () => {
  test('有错误时渲染错误行并隐藏提示', () => {
    const html = renderToStaticMarkup(
      <FormField
        id="setup-username"
        label="label"
        hint="hint text"
        error="nodes.setup.errors.invalid_username"
      >
        <input id="setup-username" />
      </FormField>
    );
    expect(html).toContain('data-testid="setup-username-error"');
    expect(html).toContain('nodes.setup.errors.invalid_username');
    expect(html).not.toContain('hint text');
  });

  test('无错误时只渲染提示', () => {
    const html = renderToStaticMarkup(
      <FormField id="setup-username" label="label" hint="hint text">
        <input id="setup-username" />
      </FormField>
    );
    expect(html).toContain('hint text');
    expect(html).not.toContain('data-testid="setup-username-error"');
  });
});
