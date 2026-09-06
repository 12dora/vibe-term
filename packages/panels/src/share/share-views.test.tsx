// bun test 无 DOM：复用 watch 的静态渲染夹具（i18n + RuntimeProvider + QueryClient）断言输出。

import { beforeAll, describe, expect, test } from 'bun:test';
import type { ShareOriginCandidate, ShareRecord } from '@vibeterm/shared/share';
import { renderWatch as renderPanel, setupWatchTestEnv } from '../watch/watch-test-harness';
import { ShareActiveView } from './share-active-view';
import { ShareCreateForm } from './share-create-form';
import { type ShareDraft, type ShareLinkPassword, createShareDraft } from './share-dialog-model';
import { shareOriginLabel } from './share-origin-label';

beforeAll(setupWatchTestEnv);

function draft(overrides: Partial<ShareDraft> = {}): ShareDraft {
  return {
    ...createShareDraft({ name: 'build', password: 'Ab3dEf7h', origin: 'https://a.example' }),
    ...overrides,
  };
}

const candidates: ShareOriginCandidate[] = [
  {
    url: 'https://a.example',
    kind: 'site',
    label: 'a.example',
    accessUrl: 'https://a.example',
  },
];

function createForm(props: Partial<Parameters<typeof ShareCreateForm>[0]> = {}) {
  return renderPanel(
    <ShareCreateForm
      draft={draft()}
      setField={() => undefined}
      onRegeneratePassword={() => undefined}
      candidates={candidates}
      submitting={false}
      onSubmit={() => undefined}
      {...props}
    />
  ).html;
}

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 's1',
    name: 'build',
    deviceId: 'd1',
    windowId: '@1',
    windowName: 'build',
    state: 'active',
    endReason: null,
    createdAt: 1_000_000,
    expiresAt: null,
    endedAt: null,
    origin: 'https://a.example',
    url: 'https://a.example/s/s1',
    viewers: 2,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...overrides,
  };
}

describe('ShareCreateForm', () => {
  test('渲染四个字段，缺省 24 小时且不展开自定义输入', () => {
    const html = createForm();
    expect(html).toContain('data-testid="share-name"');
    expect(html).toContain('data-testid="share-duration"');
    expect(html).toContain('data-testid="share-password"');
    expect(html).toContain('data-testid="share-origin"');
    expect(html).toContain('24 hours');
    expect(html).not.toContain('data-testid="share-duration-value"');
  });

  test('选自定义才出数值与单位输入', () => {
    const html = createForm({ draft: draft({ duration: 'custom' }) });
    expect(html).toContain('data-testid="share-duration-value"');
    expect(html).toContain('data-testid="share-duration-unit"');
  });

  test('地址下拉展示「种类 · host」，多条候选才分得清来路', () => {
    const relay: ShareOriginCandidate = {
      url: 'https://relay.example',
      kind: 'relay',
      label: 'relay.example',
      accessUrl: 'https://relay.example/n/abc',
    };
    const html = createForm({
      draft: draft({ origin: relay.url }),
      candidates: [relay, ...candidates],
    });
    expect(html).toContain('Relay · relay.example');
  });

  test('没有候选地址时给出提示并禁用创建', () => {
    const html = createForm({ candidates: [] });
    expect(html).toContain('data-testid="share-no-address"');
    expect(html).toContain('No public address is configured');
    expect(html).not.toContain('data-testid="share-origin"');
    expect(html).toContain('data-testid="share-create-submit"');
    expect(html).toMatch(/data-testid="share-create-submit"[^>]*disabled/);
  });
});

describe('shareOriginLabel', () => {
  const t = (key: string) => key;

  test('每种来路各有前缀，自定义地址同样带前缀（避免与「自定义…」选项混淆）', () => {
    const kinds = ['custom', 'site', 'hub', 'relay', 'tunnel', 'ip'] as const;
    expect(
      kinds.map((kind) => shareOriginLabel(t, { ...candidates[0], kind, label: 'h.example' }))
    ).toEqual(kinds.map((kind) => `common.originKind.${kind} · h.example`));
  });
});

function linkPassword(overrides: Partial<ShareLinkPassword> = {}): ShareLinkPassword {
  return {
    include: false,
    password: null,
    loading: false,
    error: null,
    setInclude: () => undefined,
    ...overrides,
  };
}

function activeView(props: Partial<Parameters<typeof ShareActiveView>[0]> = {}) {
  return renderPanel(
    <ShareActiveView
      share={record()}
      password={null}
      linkPassword={linkPassword()}
      stopping={false}
      onStop={() => undefined}
      {...props}
    />
  ).html;
}

describe('ShareActiveView', () => {
  test('展示链接与在线人数，刚创建时给出明文密码', () => {
    const html = activeView({ password: 'Ab3dEf7h' });
    expect(html).toContain('value="https://a.example/s/s1"');
    expect(html).toContain('value="Ab3dEf7h"');
    expect(html).toContain('2 online');
    expect(html).toContain('Never expires');
    expect(html).toContain('data-testid="share-stop"');
  });

  test('已有分享只给遮罩与一次性提示，复制按钮禁用', () => {
    const html = activeView();
    expect(html).toContain('••••••••');
    expect(html).toContain('The password is shown only at creation.');
    expect(html).toMatch(/data-testid="share-active-password-copy"[^>]*disabled/);
  });

  test('限期分享展示剩余期限', () => {
    const now = 1_700_000_000_000;
    const html = activeView({ share: record({ expiresAt: now + 3 * 86_400_000 }), now });
    expect(html).toContain('3 d left');
    expect(html).not.toContain('Never expires');
  });

  test('缺省不勾「链接中包含密码」，链接是裸的', () => {
    const html = activeView({ password: 'Ab3dEf7h' });
    expect(html).toContain('data-testid="share-include-password"');
    expect(html).toContain('Include the password in the link');
    expect(html).toContain('value="https://a.example/s/s1"');
    expect(html).not.toContain('#p=');
  });

  test('勾上后链接带密码 fragment', () => {
    const html = activeView({
      password: 'Ab3dEf7h',
      linkPassword: linkPassword({ include: true, password: 'Ab3dEf7h' }),
    });
    expect(html).toContain('value="https://a.example/s/s1#p=Ab3dEf7h"');
  });

  test('已有分享取回密码后，密码栏不再遮罩——链接里已经明文可见', () => {
    const html = activeView({
      linkPassword: linkPassword({ include: true, password: 'Ab3dEf7h' }),
    });
    expect(html).toContain('value="Ab3dEf7h"');
    expect(html).not.toContain('••••••••');
    expect(html).not.toContain('The password is shown only at creation.');
  });

  test('取密码失败就地摆出原因（旧分享看不到密码）', () => {
    const html = activeView({
      linkPassword: linkPassword({ error: 'share.error.passwordUnavailable' }),
    });
    expect(html).toContain('data-testid="share-include-password-error"');
    expect(html).toContain('The password of this share cannot be viewed.');
  });
});
