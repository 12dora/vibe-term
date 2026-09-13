// DirectEnableSwitch / NodeNameField / AccountCredentialFields / SetupSubmitRow 的静态渲染。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountCredentialFields,
  DirectEnableSwitch,
  NodeNameField,
  SetupSubmitRow,
} from './form-parts';

describe('DirectEnableSwitch', () => {
  test('平台支持时开关可用，文案走 hub 提示', () => {
    const html = renderToStaticMarkup(
      <DirectEnableSwitch
        id="setup-direct-enable"
        checked
        supported
        platform="darwin-arm64"
        onCheckedChange={() => {}}
      />
    );
    expect(html).toContain('data-testid="setup-direct-enable"');
    expect(html).toContain('nodes.setup.fields.directEnable');
    expect(html).toContain('nodes.setup.fields.directEnableHint');
    expect(html).not.toContain('disabled=""');
  });

  test('平台不支持时开关禁用并换文案', () => {
    const html = renderToStaticMarkup(
      <DirectEnableSwitch
        id="setup-join-direct-enable"
        checked
        supported={false}
        platform="freebsd-x64"
        onCheckedChange={() => {}}
      />
    );
    expect(html).toContain('data-testid="setup-join-direct-enable"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('nodes.setup.fields.directUnsupportedHint');
    expect(html).not.toContain('nodes.setup.fields.directEnableHint');
  });

  test('kind=relay 用中继版文案，不提 Hub 中转', () => {
    const html = renderToStaticMarkup(
      <DirectEnableSwitch
        id="setup-relay-join-direct-enable"
        checked
        supported
        platform="darwin-arm64"
        kind="relay"
        onCheckedChange={() => {}}
      />
    );
    expect(html).toContain('data-testid="setup-relay-join-direct-enable"');
    expect(html).toContain('nodes.setup.fields.directEnableRelayHint');
    expect(html).not.toContain('nodes.setup.fields.directEnableHint');
  });

  test('kind=relay 且不支持时用中继版禁用文案', () => {
    const html = renderToStaticMarkup(
      <DirectEnableSwitch
        id="setup-relay-direct-enable"
        checked={false}
        supported={false}
        platform="freebsd-x64"
        kind="relay"
        onCheckedChange={() => {}}
      />
    );
    expect(html).toContain('data-testid="setup-relay-direct-enable"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('nodes.setup.fields.directUnsupportedRelayHint');
    expect(html).not.toContain('nodes.setup.fields.directUnsupportedHint');
  });
});

describe('NodeNameField', () => {
  test('无错误时渲染提示，id 即 testid 输入框', () => {
    const html = renderToStaticMarkup(
      <NodeNameField id="setup-node-name" value="studio" onChange={() => {}} />
    );
    expect(html).toContain('id="setup-node-name"');
    expect(html).toContain('value="studio"');
    expect(html).toContain('nodes.setup.fields.nameHint');
    expect(html).not.toContain('data-testid="setup-node-name-error"');
  });

  test('有错误时渲染错误行并隐藏提示', () => {
    const html = renderToStaticMarkup(
      <NodeNameField
        id="setup-relay-node-name"
        value=""
        error="nodes.setup.errors.invalid_name"
        onChange={() => {}}
      />
    );
    expect(html).toContain('data-testid="setup-relay-node-name-error"');
    expect(html).toContain('nodes.setup.errors.invalid_name');
    expect(html).not.toContain('nodes.setup.fields.nameHint');
  });
});

describe('AccountCredentialFields', () => {
  test('三个字段的 id 原样落到输入框', () => {
    const html = renderToStaticMarkup(
      <AccountCredentialFields
        ids={{
          username: 'setup-username',
          password: 'setup-password',
          confirm: 'setup-confirm-password',
        }}
        values={{ username: 'alice', password: '', confirmPassword: '' }}
        errors={{}}
        onChange={() => {}}
      />
    );
    expect(html).toContain('id="setup-username"');
    expect(html).toContain('value="alice"');
    expect(html).toContain('id="setup-password"');
    expect(html).toContain('id="setup-confirm-password"');
    expect(html).toContain('data-testid="setup-password-generate"');
  });

  test('中继兼节点用另一套 id，错误行挂在对应字段上', () => {
    const html = renderToStaticMarkup(
      <AccountCredentialFields
        ids={{
          username: 'setup-relay-username',
          password: 'setup-relay-account-password',
          confirm: 'setup-relay-confirm-password',
        }}
        values={{ username: '', password: 'short', confirmPassword: 'nope' }}
        errors={{
          username: 'nodes.setup.errors.invalid_username',
          password: 'nodes.setup.errors.weak_password',
          confirmPassword: 'nodes.setup.errors.password_mismatch',
        }}
        onChange={() => {}}
      />
    );
    expect(html).toContain('data-testid="setup-relay-username-error"');
    expect(html).toContain('data-testid="setup-relay-account-password-error"');
    expect(html).toContain('data-testid="setup-relay-confirm-password-error"');
    expect(html).toContain('data-testid="setup-relay-account-password-generate"');
  });
});

describe('SetupSubmitRow', () => {
  test('submitError 时在按钮前渲染错误条', () => {
    const html = renderToStaticMarkup(
      <SetupSubmitRow
        testId="setup-join-hub"
        label="Join"
        submitting={false}
        blocked={false}
        submitError="boom"
      />
    );
    expect(html).toContain('data-testid="setup-join-hub-error"');
    expect(html).toContain('boom');
    expect(html).toContain('data-testid="setup-join-hub-submit"');
  });

  test('无 submitError 时不渲染错误条', () => {
    const html = renderToStaticMarkup(
      <SetupSubmitRow
        testId="setup-become-hub"
        label="Create"
        submitting={false}
        blocked={false}
        submitError={null}
      />
    );
    expect(html).not.toContain('data-testid="setup-become-hub-error"');
    expect(html).toContain('data-testid="setup-become-hub-submit"');
  });
});
