// 向导的静态渲染：路径选择、按 nodeEnv 显隐 insecureLocal、预填规则、校验文案的呈现。

import { describe, expect, test } from 'bun:test';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { HubSetupWizard } = await import('./hub-setup-wizard');
const { BecomeHubForm } = await import('./become-hub-form');
const { BecomeRelayForm } = await import('./become-relay-form');
const { JoinHubForm } = await import('./join-hub-form');
const { JoinRelayForm } = await import('./join-relay-form');
const { FormField } = await import('./form-parts');

function status(overrides: Partial<LocalStatusResponse> = {}): LocalStatusResponse {
  return {
    role: 'standalone',
    nodeEnv: 'production',
    hubUrl: null,
    hubPublicUrl: null,
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

describe('HubSetupWizard', () => {
  test('localStatus 还没到时只渲染占位', () => {
    const html = renderToStaticMarkup(<HubSetupWizard localStatus={null} />);
    expect(html).toContain('data-testid="setup-wizard-loading"');
    expect(html).not.toContain('data-testid="hub-setup-wizard"');
  });

  test('已经在 mesh 里的实例不渲染向导', () => {
    expect(
      renderToStaticMarkup(<HubSetupWizard localStatus={status({ role: 'hub,node' })} />)
    ).toBe('');
    expect(renderToStaticMarkup(<HubSetupWizard localStatus={status({ role: 'node' })} />)).toBe(
      ''
    );
  });

  test('standalone 渲染四条路径且默认都未选中，不渲染任何表单', () => {
    const html = renderToStaticMarkup(<HubSetupWizard localStatus={status()} />);
    expect(html).toContain('data-testid="hub-setup-wizard"');
    for (const path of ['become-hub', 'join-hub', 'join-relay', 'become-relay']) {
      expect(html).toContain(`data-testid="setup-path-${path}" data-selected="false"`);
    }
    expect(html).not.toContain('data-testid="setup-become-hub-form"');
    expect(html).not.toContain('data-testid="setup-join-hub-form"');
    expect(html).not.toContain('data-testid="setup-become-relay-form"');
    expect(html).not.toContain('data-testid="setup-join-relay-form"');
  });

  test('选中 join-relay 时渲染加入中继表单', () => {
    const html = renderToStaticMarkup(
      <HubSetupWizard localStatus={status()} initialPath="join-relay" hostname="studio" />
    );
    expect(html).toContain('data-testid="setup-join-relay-form"');
    expect(html).not.toContain('data-testid="setup-become-relay-form"');
    expect(html).toContain('data-testid="setup-path-join-relay" data-selected="true"');
  });

  test('选中 become-relay 时渲染中继表单', () => {
    const html = renderToStaticMarkup(
      <HubSetupWizard localStatus={status()} initialPath="become-relay" origin={null} />
    );
    expect(html).toContain('data-testid="setup-become-relay-form"');
    expect(html).not.toContain('data-testid="setup-become-hub-form"');
    expect(html).toContain('data-testid="setup-path-become-relay" data-selected="true"');
    // 默认中继兼节点：建账号，不出纯中继告警
    expect(html).toContain('id="setup-relay-username"');
    expect(html).not.toContain('data-testid="setup-relay-pure-notice"');
  });

  test('跨重启记号恢复出来的「纯中继」赢过默认的「中继兼节点」', () => {
    const html = renderToStaticMarkup(
      <HubSetupWizard
        localStatus={status()}
        initialPath="become-relay"
        initialRelayRole="relay"
        origin={null}
      />
    );
    expect(html).toContain('data-testid="setup-relay-pure-notice"');
    expect(html).not.toContain('id="setup-relay-username"');
  });

  test('选中 become-hub 时渲染对应表单且该卡片高亮', () => {
    const html = renderToStaticMarkup(
      <HubSetupWizard localStatus={status()} initialPath="become-hub" origin={null} />
    );
    expect(html).toContain('data-testid="setup-become-hub-form"');
    expect(html).not.toContain('data-testid="setup-join-hub-form"');
    expect(html).toContain('data-testid="setup-path-become-hub" data-selected="true"');
  });

  test('选中 join-hub 时渲染 join 表单', () => {
    const html = renderToStaticMarkup(
      <HubSetupWizard localStatus={status()} initialPath="join-hub" hostname="studio" />
    );
    expect(html).toContain('data-testid="setup-join-hub-form"');
    expect(html).not.toContain('data-testid="setup-become-hub-form"');
  });
});

describe('BecomeHubForm', () => {
  test('https origin 预填到公开地址；production 下 http origin 不预填', () => {
    const https = renderToStaticMarkup(
      <BecomeHubForm localStatus={status()} origin="https://tmex.example.com" />
    );
    expect(https).toContain('value="https://tmex.example.com"');

    const http = renderToStaticMarkup(
      <BecomeHubForm localStatus={status()} origin="http://localhost:19663" />
    );
    expect(http).not.toContain('value="http://localhost:19663"');
  });

  test('非 production 下本地 http origin 也预填', () => {
    const html = renderToStaticMarkup(
      <BecomeHubForm
        localStatus={status({ nodeEnv: 'development' })}
        origin="http://localhost:19663"
      />
    );
    expect(html).toContain('value="http://localhost:19663"');
  });

  test('渲染可达性检查按钮、四个输入与直连开关', () => {
    const html = renderToStaticMarkup(<BecomeHubForm localStatus={status()} origin={null} />);
    expect(html).toContain('data-testid="setup-precheck-button"');
    expect(html).toContain('id="setup-hub-public-url"');
    expect(html).toContain('id="setup-username"');
    expect(html).toContain('id="setup-password"');
    expect(html).toContain('id="setup-confirm-password"');
    expect(html).toContain('data-testid="setup-direct-enable"');
    expect(html).toContain('data-testid="setup-become-hub-submit"');
    // 尚未提交，不应出现任何校验错误。
    expect(html).not.toContain('-error"');
  });

  test('平台不支持直连时开关禁用', () => {
    const html = renderToStaticMarkup(
      <BecomeHubForm
        localStatus={status({
          direct: {
            supported: false,
            installed: false,
            enabled: true,
            capable: false,
            version: null,
            platform: 'freebsd-x64',
          },
        })}
        origin={null}
      />
    );
    expect(html).toContain('data-testid="setup-direct-enable"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('nodes.setup.fields.directUnsupportedHint');
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

  test('直连提示用中继版文案，不提 Hub 中转', () => {
    const html = renderToStaticMarkup(<BecomeRelayForm localStatus={status()} origin={null} />);
    expect(html).toContain('nodes.setup.fields.directEnableRelayHint');
    expect(html).not.toContain('nodes.setup.fields.directEnableHint');
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

describe('JoinHubForm', () => {
  test('production 下不出现 insecureLocal 开关', () => {
    const html = renderToStaticMarkup(<JoinHubForm localStatus={status()} hostname="studio" />);
    expect(html).not.toContain('data-testid="setup-insecure-local"');
  });

  test('development / test 下出现 insecureLocal 开关', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      const html = renderToStaticMarkup(
        <JoinHubForm localStatus={status({ nodeEnv })} hostname="studio" />
      );
      expect(html).toContain('data-testid="setup-insecure-local"');
    }
  });

  test('节点名默认取浏览器主机名，取不到时退化成 node', () => {
    expect(
      renderToStaticMarkup(<JoinHubForm localStatus={status()} hostname="studio" />)
    ).toContain('value="studio"');
    expect(renderToStaticMarkup(<JoinHubForm localStatus={status()} hostname={null} />)).toContain(
      'value="node"'
    );
  });

  test('默认是密码方式：密码输入框 + 「改用加入码」入口，不渲染加入码输入', () => {
    const html = renderToStaticMarkup(<JoinHubForm localStatus={status()} hostname="studio" />);
    expect(html).toContain('data-testid="setup-join-password-input"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-testid="setup-join-method-token"');
    expect(html).toContain('nodes.setup.joinHub.passwordDescription');
    expect(html).not.toContain('data-testid="setup-join-token-input"');
    expect(html).toContain('data-testid="setup-join-hub-submit"');
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
  });

  test('直连提示用中继版文案，不提 Hub 中转', () => {
    const html = renderToStaticMarkup(<JoinRelayForm localStatus={status()} hostname="studio" />);
    expect(html).toContain('nodes.setup.fields.directEnableRelayHint');
    expect(html).not.toContain('nodes.setup.fields.directEnableHint');
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
